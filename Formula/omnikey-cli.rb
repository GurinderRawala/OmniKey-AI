class OmnikeyCli < Formula
  desc "CLI tool for Omnikey AI - keyboard shortcut AI assistant"
  homepage "https://github.com/GurinderRawala/OmniKey-AI"
  version "1.8.2"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/GurinderRawala/OmniKey-AI/releases/download/v#{version}/omnikey-cli-#{version}-darwin-arm64.tar.gz"
      sha256 "cff90baa9d4c2ae2699b9cbb4b028d93692b4cbd37649632382bc287ed51504f"
    end

    on_intel do
      url "https://github.com/GurinderRawala/OmniKey-AI/releases/download/v#{version}/omnikey-cli-#{version}-darwin-x86_64.tar.gz"
      sha256 "7f69a7ac0745fa376ec8f67d93be741c8c42f4bce8e16656367fb934b9bd2e1e"
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
