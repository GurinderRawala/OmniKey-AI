import XCTest
@testable import OmniKeyAI

/// Heredoc-aware literal reading for Git provenance. Bodies are data: a
/// `git commit` inside one is never an invocation, while commands outside
/// are read exactly as before. Anything not delimited exactly fails closed.
final class GitHeredocAnalyzerTests: XCTestCase {
    private func analyze(_ script: String, in directory: String? = "/repo") -> GitShellCommandAnalyzer.Analysis {
        GitShellCommandAnalyzer.analyze(script, initialDirectory: directory, homeDirectory: "/home/u")
    }

    /// Shape of the last real session's commit script: staged-file check in
    /// a quoted Python heredoc, then a literal commit.
    static func verificationScript(files: [String], message: String, commitFlags: String = "") -> String {
        let quotedFiles = files.map { "'\($0)'" }.joined(separator: " ")
        let expected = files.map { "\"\($0)\"" }.joined(separator: ", ")
        return """
        git add -- \(quotedFiles)
        python3 - <<'PY'
        import subprocess
        # Decoys the shell never runs: git commit -m "decoy"; git reset --hard
        staged = subprocess.run(["git", "diff", "--cached", "--name-only"], capture_output=True, text=True, check=True).stdout.split()
        assert sorted(staged) == sorted([\(expected)]), f"unexpected staged files: {staged!r}"
        print('staged ok')
        PY
        git diff --cached --check
        git \(commitFlags)\(commitFlags.isEmpty ? "" : " ")commit -m "\(message)"
        """
    }

    func testExactProductionRegressionScriptAttributesStructuredDirectory() {
        let script = Self.verificationScript(
            files: ["a.swift", "b.swift", "c.swift", "d.swift"],
            message: "fix(macOS): clarify management controls with hover hints"
        )
        // Production applies the structured cwd as a quoted literal prefix.
        let a = analyze(ChatSessionRunner.script(script, in: "/work/it's repo"), in: "/elsewhere")
        XCTAssertEqual(a.commitDirectories, ["/work/it's repo"])
        XCTAssertFalse(a.hasDisqualifyingGitActivity)
        XCTAssertTrue(a.canAttribute)
    }

    func testOriginalCheckOutputVerificationShape() {
        let script = """
        git add -- a.swift b.swift c.swift d.swift
        python3 - <<'PY'
        import subprocess
        expected={f'macOS/Sources/{n}.swift' for n in ['MCPServersView','ScheduledJobsView','SkillsView','TaskInstructionsView']}
        assert set(subprocess.check_output(['git','diff','--cached','--name-only'],text=True).splitlines())==expected
        PY
        git diff --cached --check
        git commit -m "fix(macOS): clarify management controls with hover hints"
        """
        XCTAssertTrue(analyze(script).canAttribute)
    }

    func testDecoyCommitInsideHeredocIsExcludedOutsideIsDetected() {
        let decoyOnly = analyze("cat <<'EOF'\ngit commit -m decoy\ngit reset --hard HEAD~3\nEOF\necho done")
        XCTAssertTrue(decoyOnly.commitDirectories.isEmpty)
        XCTAssertFalse(decoyOnly.hasDisqualifyingGitActivity, "body text is data, not a checkout/reset")

        let outside = analyze("cat > notes.txt <<'EOF'\ngit checkout main\nEOF\ngit commit -m real")
        XCTAssertEqual(outside.commitDirectories, ["/repo"])
        XCTAssertTrue(outside.canAttribute)

        let sameLine = analyze("cat <<'EOF' && git -C /other commit -m x\nbody\nEOF")
        XCTAssertEqual(sameLine.commitDirectories, ["/other"])
    }

    func testDelimiterQuotingForms() {
        for op in ["<<'EOF'", "<<\"EOF\"", "<<\\EOF", "<<E\"O\"F", "<< 'EOF'", "<<EOF"] {
            let a = analyze("cat \(op)\ngit commit -m decoy \"x\n'y\nEOF\ngit commit -m real")
            XCTAssertEqual(a.commitDirectories, ["/repo"], op)
            XCTAssertTrue(a.canAttribute, op)
        }
    }

    func testTabStrippingOnlyWithDash() {
        let dash = analyze("cat <<-EOF\n\tgit commit -m decoy\n\t\tEOF\ngit commit -m real")
        XCTAssertEqual(dash.commitDirectories, ["/repo"])
        // Without `-`, a tab-indented terminator does not end the body, so
        // the rest of the script is body and the heredoc is unterminated.
        let plain = analyze("cat <<EOF\nbody\n\tEOF\ngit commit -m real")
        XCTAssertFalse(plain.canAttribute)
        XCTAssertTrue(plain.hasDisqualifyingGitActivity)
    }

    func testMultipleQueuedHeredocsAreConsumedInOrder() {
        let a = analyze("cat <<A - <<'B'; cat <<-C\nfirst git commit\nA\nsecond git reset\nB\n\tthird git pull\n\tC\ngit commit -m real")
        XCTAssertEqual(a.commitDirectories, ["/repo"])
        XCTAssertTrue(a.canAttribute)
        // Terminators out of order leave B unterminated.
        XCTAssertFalse(analyze("cat <<A <<B\nB\nA\ngit commit -m x").canAttribute)
    }

    func testHeredocInsideQuotedCommandSubstitutionMessage() {
        let script = "git commit -m \"$(cat <<'EOF'\nfix: say \"hi\" to 'git reset --hard'\n\nBody; git checkout main\nEOF\n)\""
        let a = analyze(script)
        XCTAssertEqual(a.commitDirectories, ["/repo"])
        XCTAssertTrue(a.canAttribute)
    }

    func testCRLFAndMalformedHeredocsFailClosed() {
        let cases = [
            "python3 - <<'PY'\r\nprint(1)\r\nPY\r\ngit commit -m x\r\n", // CR in delimiter word
            "cat <<'PY'\nprint(1)\nPY\r\ngit commit -m x",               // CR-terminated terminator line
            "cat <<'EOF'\nnever closed\ngit commit -m x",
            "cat <<\ngit commit -m x",
            "cat <<<'here string'; git commit -m x",
            "cat <<$DELIM\nx\n$DELIM\ngit commit -m x",
            "cat <<'E F'\nx\nE F\ngit commit -m x",
            "cat <<'EOF\nx\nEOF\ngit commit -m x",
            "cat <<EOF \\\n && true\nx\nEOF\ngit commit -m x",
            "cat <<EOF\nline \\\nEOF\nEOF\ngit commit -m x",
            "git commit -m x; cat <<EOF",
        ]
        for script in cases {
            let a = analyze(script)
            XCTAssertFalse(a.canAttribute, script.debugDescription)
            XCTAssertTrue(a.hasDisqualifyingGitActivity, script.debugDescription)
        }
    }

    func testUnquotedBodyExpansionsThatCanRunCommandsFailClosed() {
        for body in ["$(git commit -m sneaky)", "`git reset --hard`", "${X:-$(touch y)}", "$[1+2]", "${(e)PAYLOAD}"] {
            XCTAssertFalse(analyze("cat <<EOF\n\(body)\nEOF\ngit commit -m x").canAttribute, body)
            // The same text under a quoted delimiter is inert.
            XCTAssertTrue(analyze("cat <<'EOF'\n\(body)\nEOF\ngit commit -m x").canAttribute, body)
        }
        XCTAssertTrue(analyze("cat <<EOF\nhome is $HOME and $1\nEOF\ngit commit -m x").canAttribute)
    }

    func testShellFedHeredocMentioningGitIsOpaque() {
        for shell in ["bash", "sh -s", "/bin/zsh", "FOO=1 bash"] {
            XCTAssertFalse(analyze("\(shell) <<'EOF'\ngit reset --hard\nEOF\ngit commit -m x").canAttribute, shell)
        }
        XCTAssertTrue(analyze("bash <<'EOF'\necho hi\nEOF\ngit commit -m x").canAttribute)
        // A commit run only by the nested interpreter is never counted.
        XCTAssertTrue(analyze("python3 - <<'PY'\nimport os; os.system('git commit -m x')\nPY").commitDirectories.isEmpty)
    }

    func testIndirectInterpreterHeredocsCannotGrantAttribution() {
        let scripts = [
            "git commit -m \"$(cat /dev/null)$(bash <<'EOF'\ngit pull\nEOF\n)\"",
            "cat <<'EOF' | sh\ngit merge feature\nEOF\ngit commit -m x",
            "sudo bash <<'EOF'\ngit reset --hard HEAD~3\nEOF\ngit commit -m x",
            "env bash <<'EOF'\ngit pull\nEOF\ngit commit -m x",
            "python3 - <<'EOF'\nsubprocess.run(['git','pull'])\nEOF\ngit commit -m x",
            "x=\"$(bash <<'EOF'\ngit pull\nEOF\n)\"\ngit commit -m x",
            "sh -c \"$(cat <<'EOF'\ngit pull\nEOF\n)\"\ngit commit -m x"
        ]
        for script in scripts { XCTAssertFalse(analyze(script).canAttribute, script) }
    }

    func testSubstitutionAndEvalAreNotExecutedCommits() {
        for script in ["echo \"$(git commit -m x)\"", "x=`git commit -m x`", "eval git commit -m x"] {
            let a = analyze(script)
            XCTAssertTrue(a.commitDirectories.isEmpty, script)
            XCTAssertFalse(a.canAttribute, script)
        }
        XCTAssertFalse(analyze("git commit -m x; y=$(git reset --hard HEAD~1)").canAttribute)
        XCTAssertTrue(analyze("echo 'git commit is prose' # git commit").commitDirectories.isEmpty)
    }

    func testStrongRulesStillApplyAroundHeredocs() {
        let cases = [
            "cat <<'EOF'\nx\nEOF\ngit checkout main && git commit -m x",
            "cat <<'EOF'\nx\nEOF\ngit commit --amend -m x",
            "cat <<'EOF'\nx\nEOF\nGIT_DIR=/x/.git git commit -m x",
            "cat <<'EOF'\nx\nEOF\ncd $REPO && git commit -m x",
            "cat <<'EOF'\nx\nEOF\nsudo git commit -m x",
        ]
        for script in cases {
            XCTAssertFalse(analyze(script).canAttribute, script)
        }
        XCTAssertFalse(analyze("cat <<'EOF'\nx\nEOF\ngit commit -m x", in: nil).canAttribute, "unknown cwd")
    }
}

/// Real temporary repositories, the production `cd` prefix, the production
/// shell runner and the strict HEAD/reflog/ancestry gate.
final class GitHeredocProvenanceTests: XCTestCase {
    private let commitFlags = "-c user.name=T -c user.email=t@example.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null"

    private func execute(_ script: String) -> Int32 {
        runShellCommandWithStatus(script, processRegistrar: { _ in }).status
    }

    private func python3Available() -> Bool {
        execute("command -v python3 >/dev/null 2>&1") == 0
    }

    func testVerificationHeredocCommitIsObservedAndCollectable() throws {
        try XCTSkipUnless(python3Available(), "python3 not available")
        let repo = try GitTestRepo()
        try repo.write("a.swift", "a\n")
        try repo.write("b.swift", "b\n")
        let before = try repo.commitAll("base")
        try repo.write("a.swift", "a\nagent a\n")
        try repo.write("b.swift", "b\nagent b\n")
        try repo.write("untouched.txt", "u\n")
        try repo.git("add", "untouched.txt")
        try repo.git("commit", "-q", "-m", "user")
        let base = try repo.git("rev-parse", "HEAD")
        XCTAssertNotEqual(base, before)

        let body = GitHeredocAnalyzerTests.verificationScript(
            files: ["a.swift", "b.swift"], message: "fix(macOS): clarify hints", commitFlags: commitFlags
        )
        let script = ChatSessionRunner.script(body, in: repo.root)
        let tracker = GitProvenanceTracker()
        let baseline = tracker.baseline(script: script, context: nil, initialDirectory: "/")
        XCTAssertFalse(baseline.isEmpty, "HEAD baseline must be captured for the commit outside the heredoc")
        XCTAssertEqual(execute(script), 0)

        let after = try repo.git("rev-parse", "HEAD")
        XCTAssertEqual(try repo.git("log", "-1", "--format=%s"), "fix(macOS): clarify hints", "decoy commit in body never ran")
        XCTAssertEqual(try repo.git("rev-list", "--count", "\(base)..HEAD"), "1")
        let observations = tracker.observations(after: baseline)
        XCTAssertEqual(observations, [GitCommitObservation(root: repo.root, before: base, after: after)])

        let response = GitSnapshotCollector().collect(GitDiffRequestPayload(
            requestID: "r", candidatePaths: [repo.root],
            eligibleCommits: observations.map { GitEligibleCommit(root: $0.root, commit: $0.after) }
        ))
        XCTAssertEqual(response.status, .ok)
        let patch = try XCTUnwrap(response.repositories.first)
        XCTAssertEqual(patch.scope, .commit)
        XCTAssertEqual(patch.commit, after)
        XCTAssertTrue(patch.patch.contains("+agent a"))
        XCTAssertTrue(patch.patch.contains("+agent b"))
        XCTAssertFalse(patch.patch.contains("untouched"))
    }

    func testFailedVerificationLeavesNoObservation() throws {
        try XCTSkipUnless(python3Available(), "python3 not available")
        let repo = try GitTestRepo()
        try repo.write("a.swift", "a\n")
        _ = try repo.commitAll("base")
        try repo.write("a.swift", "changed\n")
        // The verification heredoc fails, so the chained commit never runs.
        let body = "git add -- 'a.swift' && python3 - <<'PY' && git \(commitFlags) commit -q -m never\nimport sys\nsys.exit(1)\nPY"
        let script = ChatSessionRunner.script(body, in: repo.root)
        let tracker = GitProvenanceTracker()
        let baseline = tracker.baseline(script: script, context: nil)
        XCTAssertFalse(baseline.isEmpty)
        XCTAssertNotEqual(execute(script), 0)
        XCTAssertTrue(tracker.observations(after: baseline).isEmpty, "HEAD did not move")
    }

    func testCommitOnlyInsideHeredocBodyIsNeverAttributed() throws {
        let repo = try GitTestRepo()
        try repo.write("a.txt", "a\n")
        _ = try repo.commitAll("base")
        try repo.write("a.txt", "b\n")
        // A real commit performed by a heredoc-fed interpreter is opaque:
        // no literal commit outside the body, so nothing is baselined.
        let body = "git add -A\nbash <<'EOF'\ngit \(commitFlags) commit -q -m hidden\nEOF"
        let script = ChatSessionRunner.script(body, in: repo.root)
        let tracker = GitProvenanceTracker()
        XCTAssertTrue(tracker.baseline(script: script, context: nil).isEmpty)
        let cat = ChatSessionRunner.script("cat <<'EOF'\ngit commit -m decoy\nEOF", in: repo.root)
        XCTAssertTrue(tracker.baseline(script: cat, context: nil).isEmpty)
    }
}
