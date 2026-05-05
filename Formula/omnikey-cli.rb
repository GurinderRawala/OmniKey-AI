class OmnikeyCli < Formula
  desc "CLI tool for Omnikey AI - keyboard shortcut AI assistant"
  homepage "https://github.com/GurinderRawala/OmniKey-AI"
  version "1.0.34"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/GurinderRawala/OmniKey-AI/releases/download/v#{version}/omnikey-cli-#{version}-darwin-arm64.tar.gz"
      sha256 "032868ae44edc46cc41e47d7f8d32cbb35ba942a79f6be7a0b12448885c77b6d"
    end

    on_intel do
      url "https://github.com/GurinderRawala/OmniKey-AI/releases/download/v#{version}/omnikey-cli-#{version}-darwin-x86_64.tar.gz"
      sha256 "a724e75f3fe2c227d7bf099d341e3b4e849fe7207c56a964a7d465925f9748ce"
    end
  end

  depends_on "node"

  def install
    libexec.install Dir["*"]

    node = Formula["node"].opt_bin/"node"
    (bin/"omnikey").write <<~EOS
      #!/bin/bash
      exec "#{node}" "#{libexec}/dist/index.js" "$@"
    EOS
  end

  test do
    assert_match "omnikey", shell_output("#{bin}/omnikey --help")
  end
end
