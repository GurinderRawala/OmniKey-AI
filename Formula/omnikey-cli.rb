class OmnikeyCli < Formula
  desc "CLI tool for Omnikey AI - keyboard shortcut AI assistant"
  homepage "https://github.com/GurinderRawala/OmniKey-AI"
  version "1.6.9"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/GurinderRawala/OmniKey-AI/releases/download/v#{version}/omnikey-cli-#{version}-darwin-arm64.tar.gz"
      sha256 "27e6a35ae06fe2f7eceacc3cc20cd07e660e6342ce2ae6c37c32bc3f8eefba51"
    end

    on_intel do
      url "https://github.com/GurinderRawala/OmniKey-AI/releases/download/v#{version}/omnikey-cli-#{version}-darwin-x86_64.tar.gz"
      sha256 "fbc5e4e0a6b96123d96450782915ef3b0fdc587f8ff4fe431d127361d03b3f82"
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
