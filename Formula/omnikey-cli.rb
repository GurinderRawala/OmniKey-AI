class OmnikeyCli < Formula
  desc "CLI tool for Omnikey AI - keyboard shortcut AI assistant"
  homepage "https://github.com/GurinderRawala/OmniKey-AI"
  version "1.0.42"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/GurinderRawala/OmniKey-AI/releases/download/v#{version}/omnikey-cli-#{version}-darwin-arm64.tar.gz"
      sha256 "3cf7040ea658d0e70273f09d379d5de56f68104416dccbebdab14097b0971e41"
    end

    on_intel do
      url "https://github.com/GurinderRawala/OmniKey-AI/releases/download/v#{version}/omnikey-cli-#{version}-darwin-x86_64.tar.gz"
      sha256 "10e790b11ce21f1afbabee477887cac828dd036a4d7c85c83c92ebc89bde3766"
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
