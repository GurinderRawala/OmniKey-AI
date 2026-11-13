class OmnikeyCli < Formula
  desc "CLI tool for Omnikey AI - keyboard shortcut AI assistant"
  homepage "https://github.com/GurinderRawala/OmniKey-AI"
  version "1.8.21"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/GurinderRawala/OmniKey-AI/releases/download/v#{version}/omnikey-cli-#{version}-darwin-arm64.tar.gz"
      sha256 "5a8f85dab4ae2d7ef87bc4c261b5ec257e2922657c3e691fedf2bbabbd9e6dfa"
    end

    on_intel do
      url "https://github.com/GurinderRawala/OmniKey-AI/releases/download/v#{version}/omnikey-cli-#{version}-darwin-x86_64.tar.gz"
      sha256 "051d94c8911f4b7eebbdfb8f0bbd589a3c636f54e07f4e6b24543a99e281fb46"
    end
  end

  depends_on "node@26"

  def install
    libexec.install Dir["*"]

    node = Formula["node@26"].opt_bin/"node"
    (bin/"omnikey").write <<~EOS
      #!/bin/bash
      exec "#{node}" "#{libexec}/dist/index.js" "$@"
    EOS
  end

  test do
    assert_match "omnikey", shell_output("#{bin}/omnikey --help")
  end
end
