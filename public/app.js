document.getElementById('year').textContent = new Date().getFullYear();

// Fetch and display download counts
(function () {
  fetch('/api/downloads')
    .then((r) => r.json())
    .then(({ macos, windows }) => {
      const total = macos + windows;
      if (!total) return;

      ['hero', 'cta'].forEach((prefix) => {
        document.getElementById(`${prefix}-total-count`).textContent = total.toLocaleString();
        document.getElementById(`${prefix}-download-stats`).hidden = false;
      });
    })
    .catch(() => {/* silently ignore */});
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
