namespace OmniKey.Windows
{
    /// <summary>
    /// The Terms & Conditions bundled with the Windows desktop app. Kept in
    /// sync with the top-level <c>TERMS.md</c> file. Bump
    /// <see cref="CurrentVersion"/> whenever the text changes materially so
    /// previously-accepting users are re-prompted on next launch.
    /// </summary>
    internal static class TermsContent
    {
        /// <summary>
        /// Bump whenever <see cref="Text"/> (or TERMS.md) is updated
        /// materially. Format: date of the terms revision.
        /// </summary>
        public const string CurrentVersion = "2026-01-01";

        /// <summary>
        /// Full Markdown source of the current Terms & Conditions.
        /// Mirrors <c>TERMS.md</c> at the repository root.
        /// </summary>
        public const string Text = @"# OmniKey AI — Terms and Conditions

**Effective date:** 2026-01-01
**Publisher:** Gurinder Singh (""OmniKey"", ""we"", ""us"")
**Contact:** gurinderrawala@gmail.com
**Website:** https://omnikeyai.ca
**Source code:** https://github.com/GurinderRawala/OmniKey-AI

By downloading, installing, launching, or using the OmniKey AI desktop
application, command-line interface, or any related component (collectively,
the ""Software""), you agree to these Terms and Conditions (""Terms""). If you do
not agree, do not install or use the Software.

---

## 1. Open-Source Software

OmniKey AI is **open-source software** released under the MIT License. The
full text of the license is distributed with the Software (see the `LICENSE`
file in the source repository) and applies to every binary, script, and
source file we ship, unless a third-party component is explicitly marked
otherwise.

You are free to inspect, modify, and redistribute the Software under the
terms of the MIT License. Nothing in these Terms restricts the rights granted
to you by that license.

## 2. License Grant

Subject to your compliance with these Terms and the MIT License, OmniKey
grants you a worldwide, royalty-free, non-exclusive license to install and
use the Software on any number of devices you own or control.

## 3. Third-Party Services

The Software integrates with third-party AI providers (OpenAI, Anthropic,
Google Gemini, Nemotron, and others), search providers, and Model Context
Protocol servers that you configure. You are solely responsible for:

- Obtaining and paying for your own API keys and subscriptions.
- Complying with each third-party service's own terms of service and
  acceptable-use policies.
- Any content you submit to, or receive from, those services.

OmniKey does not control, endorse, or assume any responsibility for the
availability, accuracy, content, or practices of any third-party service.

## 4. AI-Generated Content

The Software transforms text you select and returns AI-generated output. AI
output may be inaccurate, incomplete, biased, offensive, or otherwise
unsuitable for your purpose. **You are responsible for reviewing every AI
response before relying on it, publishing it, or acting on it.** Do not use
the Software to make medical, legal, financial, safety-critical, or other
high-stakes decisions without independent verification.

## 5. Your Data

The Software runs locally on your machine. Content you select is sent
directly from your device to the AI provider you configured. OmniKey does
not operate a server that stores your prompts or responses on your behalf,
except where you explicitly enable an OmniKey-hosted feature (for example,
the optional SaaS subscription flow).

You are responsible for the content you send through the Software and for
ensuring you have the right to send it.

## 6. No Warranty

**THE SOFTWARE IS PROVIDED ""AS IS"" AND ""AS AVAILABLE"", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED**, including, without limitation, the implied
warranties of merchantability, fitness for a particular purpose,
non-infringement, accuracy, reliability, and quiet enjoyment.

OmniKey does not warrant that the Software will be uninterrupted, error-free,
secure, or free of harmful components, or that any defects will be corrected.

## 7. Limitation of Liability

**TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, OMNIKEY AND ITS
CONTRIBUTORS SHALL NOT BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES**, including but not
limited to:

- loss of profits, revenue, goodwill, data, or use;
- business interruption or loss of business opportunity;
- damage to hardware, software, or other property;
- costs of substitute goods or services;
- unauthorized access to, or alteration of, your transmissions or data;
- charges incurred with third-party AI or search providers;
- damages caused by AI-generated content, whether accurate or not,

arising out of or in any way connected with your download, installation, or
use of (or inability to use) the Software, whether based on warranty,
contract, tort (including negligence), strict liability, or any other legal
theory, and whether or not OmniKey has been advised of the possibility of
such damages.

Some jurisdictions do not allow the exclusion of certain warranties or the
limitation of liability for consequential or incidental damages, so some of
the limitations above may not apply to you. In such jurisdictions, OmniKey's
liability is limited to the greatest extent permitted by law.

## 8. Indemnification

You agree to indemnify, defend, and hold harmless OmniKey and its
contributors from and against any claim, demand, loss, or damage (including
reasonable attorneys' fees) arising out of or related to your use of the
Software, your content, or your violation of these Terms.

## 9. Updates

The Software may check for and download updates automatically. You may
disable auto-update from the tray/menu-bar menu. Updates are provided under
the same MIT License and these same Terms unless expressly stated otherwise.

## 10. Termination

You may stop using the Software at any time by uninstalling it. These Terms
remain in effect for any copy of the Software you continue to hold. The
rights granted to you under the MIT License survive termination, subject to
the terms of that license.

## 11. Governing Law

These Terms are governed by the laws of the Province of Ontario, Canada,
without regard to its conflict-of-laws rules, except that the MIT License
governs the license grant for the source code itself.

## 12. Changes to These Terms

We may update these Terms from time to time. The current version will always
be available in the source repository and inside the installer. Continued
use of the Software after an update constitutes acceptance of the revised
Terms.

## 13. Entire Agreement

These Terms, together with the MIT License, constitute the entire agreement
between you and OmniKey concerning the Software and supersede any prior
agreements.

---

**Summary (not a substitute for the terms above):** OmniKey AI is free,
open-source software provided as-is. You use it at your own risk. OmniKey is
not liable for any damages, data loss, third-party charges, or issues caused
by AI output or by the Software itself.
";
    }
}
