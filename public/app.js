document.getElementById('year').textContent = new Date().getFullYear();

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
