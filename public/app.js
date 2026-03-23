document.getElementById('year').textContent = new Date().getFullYear();

// Detect platform and highlight the matching download button
(function () {
  const ua = navigator.userAgent.toLowerCase();
  const isMac = /mac/.test(ua);
  const isWin = /win/.test(ua);

  if (isMac) {
    document.querySelector('.btn-mac')?.classList.add('btn-active');
  } else if (isWin) {
    document.querySelector('.btn-win')?.classList.add('btn-active');
  }

  // Copy-to-clipboard for code blocks
  document.querySelectorAll('pre').forEach((pre) => {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.setAttribute('aria-label', 'Copy');
    btn.innerHTML = '<i data-lucide="copy"></i>';
    pre.style.position = 'relative';
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
})();
