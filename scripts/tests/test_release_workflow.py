"""Exercise release PR shell steps without contacting GitHub or pushing commits."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]


def release_step(name):
    source = (ROOT / '.github/workflows/release.yml').read_text()
    section = source.split(f'      - name: {name}\n', 1)[1]
    block = section.split('        run: |\n', 1)[1].split('\n      - name:', 1)[0]
    return textwrap.dedent(block)


class ReleasePullRequests(unittest.TestCase):
    def run_step(self, name, existing='', unchanged=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'bin'
            binary.mkdir()
            (root / 'Formula').mkdir()
            (root / 'Formula/omnikey-cli.rb').write_text('formula')
            (root / 'scripts').mkdir()
            for generator in ['generate-changelog.py', 'generate-blog.py']:
                (root / 'scripts' / generator).write_text('')
            mock = '''#!/usr/bin/env python3
import json, os, pathlib, sys
command = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(json.dumps([command, *args]) + '\\n')
if command == 'git':
    if args[0] == 'clone': pathlib.Path(args[-1]).mkdir()
    if args[:3] == ['diff', '--cached', '--quiet']:
        sys.exit(0 if os.environ['UNCHANGED'] == '1' else 1)
    if args[0] == 'fetch' and args[-1].startswith('refs/heads/automation/'):
        sys.exit(1)  # First run: branch does not exist yet.
if command == 'gh' and args[:2] == ['pr', 'list']:
    print(os.environ['EXISTING_PR'])
'''
            for command in ['git', 'gh']:
                executable = binary / command
                executable.write_text(mock)
                executable.chmod(0o755)
            env = dict(os.environ, PATH=f'{binary}:{os.environ["PATH"]}',
                       CALL_LOG=str(root / 'calls'), VERSION='1.2.3',
                       GH_TOKEN='test-token', GH_REPO='owner/repo',
                       EXISTING_PR=existing, UNCHANGED=str(int(unchanged)))
            subprocess.run(['bash', '-euo', 'pipefail', '-c', release_step(name)],
                           cwd=root, env=env, check=True, capture_output=True, text=True)
            return [json.loads(line) for line in (root / 'calls').read_text().splitlines()]

    def test_create_update_and_noop_for_both_repositories(self):
        for name in ['Open pull request for formula and generated pages',
                     'Open pull request in homebrew-omnikey tap']:
            for existing, unchanged in [('', False), ('https://example.test/pr/1', False), ('', True)]:
                with self.subTest(step=name, existing=existing, unchanged=unchanged):
                    calls = self.run_step(name, existing, unchanged)
                    pushes = [c for c in calls if c[:2] == ['git', 'push']]
                    creates = [c for c in calls if c[:3] == ['gh', 'pr', 'create']]
                    self.assertEqual(len(pushes), int(not unchanged))
                    self.assertEqual(len(creates), int(not unchanged and not existing))
                    for push in pushes:
                        self.assertIn('--force-with-lease', push)
                        self.assertIn('HEAD:refs/heads/automation/release-v1.2.3', push)
                        self.assertNotIn('HEAD:main', push)
                    for create in creates:
                        self.assertEqual(create[create.index('--base') + 1], 'main')
                        self.assertEqual(create[create.index('--head') + 1], 'automation/release-v1.2.3')
                    self.assertFalse(any(c[:3] in [['gh', 'pr', 'merge'], ['gh', 'pr', 'review']] for c in calls))

    def test_missing_tap_token_fails_before_git(self):
        result = subprocess.run(['bash', '-euo', 'pipefail', '-c', release_step(
            'Open pull request in homebrew-omnikey tap')],
            env=dict(os.environ, GH_TOKEN='', VERSION='1.2.3'), capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('HOMEBREW_TAP_PAT is not configured', result.stdout)


if __name__ == '__main__':
    unittest.main()
