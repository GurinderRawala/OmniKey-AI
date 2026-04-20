document.getElementById('year').textContent = new Date().getFullYear();

// Fetch total download count and display above download buttons
(function () {
  fetch('https://omnikeyai.ca/downloads/stats')
    .then((r) => r.ok ? r.json() : Promise.reject(r.status))
    .then((data) => {
      const total = (data.macos || 0) + (data.windows || 0);
      if (total <= 0) return;
      const formatted = total.toLocaleString();
      const label = `${formatted} total downloads`;
      ['hero', 'cta'].forEach((id) => {
        const badge = document.getElementById(`download-count-${id}`);
        const text = document.getElementById(`download-count-${id}-text`);
        if (badge && text) {
          text.textContent = label;
          badge.hidden = false;
        }
      });
    })
    .catch(() => { /* silently skip if unavailable */ });
})();

// Detect platform and highlight the matching download button
(function () {
  const ua = navigator.userAgent.toLowerCase();
  const isMac = /mac/.test(ua);
  const isWin = /win/.test(ua);

  if (isMac) {
    document.querySelectorAll('.btn-mac').forEach(el => el.classList.add('btn-active'));
  } else if (isWin) {
    document.querySelectorAll('.btn-win').forEach(el => el.classList.add('btn-active'));
  }

  // Copy-to-clipboard for code blocks
  document.querySelectorAll('pre').forEach((pre) => {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.setAttribute('aria-label', 'Copy');
    btn.innerHTML = '<i data-lucide="copy"></i>';
    pre.appendChild(btn);
    lucide.createIcons({ nodes: [btn] });

    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      navigator.clipboard.writeText(code?.textContent?.trim() ?? '').then(() => {
        btn.innerHTML = '<i data-lucide="check"></i>';
        lucide.createIcons({ nodes: [btn] });
        setTimeout(() => {
          btn.innerHTML = '<i data-lucide="copy"></i>';
          lucide.createIcons({ nodes: [btn] });
        }, 2000);
      });
    });
  });

  // Inline install command tab switcher
  document.querySelectorAll('.code-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.codeTab;
      const block = tab.closest('.code-block');
      block.querySelectorAll('.code-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      block.querySelectorAll('[data-code-content]').forEach(panel => {
        panel.hidden = panel.dataset.codeContent !== target;
      });
    });
  });

  // Authenticated-browsing manual-setup tab switcher
  function activateAuthTab(tab) {
    const target = tab.dataset.authTab;
    const box = tab.closest('.auth-setup-box');
    box.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('auth-tab-active'));
    tab.classList.add('auth-tab-active');
    box.querySelectorAll('[data-auth-panel]').forEach(panel => {
      panel.hidden = panel.dataset.authPanel !== target;
    });
  }

  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => activateAuthTab(tab));
  });

  // Pre-select the tab matching the visitor's OS — AppleScript is default on macOS (easiest setup)
  const defaultAuthTab = isWin ? 'win' : 'mac-as';
  document.querySelectorAll('.auth-tabs').forEach(tabList => {
    const match = tabList.querySelector(`[data-auth-tab="${defaultAuthTab}"]`);
    if (match) activateAuthTab(match);
  });

  // Scroll-reveal via IntersectionObserver
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 }
  );

  document.querySelectorAll('.scroll-reveal').forEach((el) => observer.observe(el));
})();
