document.getElementById('year').textContent = new Date().getFullYear();

// Fetch total download count and display above download buttons
(function () {
  fetch('https://omnikeyai.ca/downloads/stats')
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
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
    .catch(() => {
      /* silently skip if unavailable */
    });
})();

// Detect platform and highlight the matching download button
(function () {
  const ua = navigator.userAgent.toLowerCase();
  const isMac = /mac/.test(ua);
  const isWin = /win/.test(ua);
  const canRenderLucide =
    typeof window.lucide !== 'undefined' && typeof window.lucide.createIcons === 'function';

  function renderIcons(nodes) {
    if (!canRenderLucide) return;
    window.lucide.createIcons({ nodes });
  }

  if (isMac) {
    document.querySelectorAll('.btn-mac').forEach((el) => el.classList.add('btn-active'));
  } else if (isWin) {
    document.querySelectorAll('.btn-win').forEach((el) => el.classList.add('btn-active'));
  }

  // Copy-to-clipboard for code blocks
  document.querySelectorAll('pre').forEach((pre) => {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Copy');
    btn.innerHTML = canRenderLucide ? '<i data-lucide="copy"></i>' : 'Copy';
    pre.appendChild(btn);
    renderIcons([btn]);

    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      navigator.clipboard.writeText(code?.textContent?.trim() ?? '').then(() => {
        btn.innerHTML = canRenderLucide ? '<i data-lucide="check"></i>' : 'Copied';
        renderIcons([btn]);
        setTimeout(() => {
          btn.innerHTML = canRenderLucide ? '<i data-lucide="copy"></i>' : 'Copy';
          renderIcons([btn]);
        }, 2000);
      });
    });
  });

  // Inline install command tab switcher
  document.querySelectorAll('.code-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.codeTab;
      const block = tab.closest('.code-block');
      block.querySelectorAll('.code-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      block.querySelectorAll('[data-code-content]').forEach((panel) => {
        panel.hidden = panel.dataset.codeContent !== target;
      });
    });
  });

  // Authenticated-browsing manual-setup tab switcher
  function activateAuthTab(tab) {
    const target = tab.dataset.authTab;
    const box = tab.closest('.auth-setup-box');
    box.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('auth-tab-active'));
    tab.classList.add('auth-tab-active');
    box.querySelectorAll('[data-auth-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.authPanel !== target;
    });
  }

  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => activateAuthTab(tab));
  });

  // Pre-select the tab matching the visitor's OS — AppleScript is default on macOS (easiest setup)
  const defaultAuthTab = isWin ? 'win' : 'mac-as';
  document.querySelectorAll('.auth-tabs').forEach((tabList) => {
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
    { threshold: 0.12 },
  );

  document.querySelectorAll('.scroll-reveal').forEach((el) => observer.observe(el));
})();

// ── Mobile menu ──
(function () {
  const btn = document.getElementById('nav-hamburger');
  const menu = document.getElementById('mobile-menu');
  if (!btn || !menu) return;

  function setOpen(open) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    document.body.classList.toggle('mobile-menu-open', open);
    if (open) {
      menu.hidden = false;
      // next frame so the transition runs
      requestAnimationFrame(() => menu.setAttribute('data-open', 'true'));
    } else {
      menu.setAttribute('data-open', 'false');
      // wait for the transition to finish before hiding
      const onEnd = () => {
        if (menu.getAttribute('data-open') !== 'true') menu.hidden = true;
        menu.removeEventListener('transitionend', onEnd);
      };
      menu.addEventListener('transitionend', onEnd);
    }
  }

  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') === 'true';
    setOpen(!open);
  });

  // Close when a link inside is clicked
  menu.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => setOpen(false));
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && btn.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      btn.focus();
    }
  });

  // Close if viewport resizes to desktop
  const mq = window.matchMedia('(min-width: 861px)');
  mq.addEventListener('change', (e) => {
    if (e.matches) setOpen(false);
  });
})();

// ── Star-on-GitHub modal ──
(function () {
  const modal = document.getElementById('star-modal');
  if (!modal) return;

  const STORAGE_KEY = 'omnikey-star-modal-v1';
  const REPO = 'GurinderRawala/OmniKey-AI';
  const OPEN_DELAY_MS = 1200;
  const COOLDOWN_DAYS = 14;
  const ONE_DAY = 24 * 60 * 60 * 1000;

  function readState() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch (_) {
      return {};
    }
  }
  function writeState(patch) {
    try {
      const next = Object.assign(readState(), patch);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (_) {
      /* storage disabled — ignore */
    }
  }
  function shouldShow() {
    const s = readState();
    if (s.starred) return false; // they clicked star — never bug them again
    if (!s.lastShownAt) return true;
    return Date.now() - s.lastShownAt > COOLDOWN_DAYS * ONE_DAY;
  }

  let lastFocused = null;

  function open() {
    if (modal.getAttribute('data-open') === 'true') return;
    lastFocused = document.activeElement;
    modal.hidden = false;
    document.body.classList.add('star-modal-open');
    requestAnimationFrame(() => modal.setAttribute('data-open', 'true'));
    writeState({ lastShownAt: Date.now() });
    // Focus the primary CTA for keyboard users
    const cta = document.getElementById('star-modal-cta');
    if (cta) setTimeout(() => cta.focus({ preventScroll: true }), 220);
    // Fetch star count once per session
    fetchStars();
  }

  function close() {
    if (modal.getAttribute('data-open') !== 'true' && !modal.hidden) return;
    modal.setAttribute('data-open', 'false');
    document.body.classList.remove('star-modal-open');
    const onEnd = (e) => {
      if (e.target !== modal.querySelector('.star-modal-card')) return;
      if (modal.getAttribute('data-open') !== 'true') modal.hidden = true;
      modal.removeEventListener('transitionend', onEnd);
    };
    modal.addEventListener('transitionend', onEnd);
    if (lastFocused && typeof lastFocused.focus === 'function') {
      try {
        lastFocused.focus({ preventScroll: true });
      } catch (_) {}
    }
  }

  // Close handlers
  modal.querySelectorAll('[data-star-close]').forEach((el) => {
    el.addEventListener('click', close);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.getAttribute('data-open') === 'true') {
      close();
    }
  });

  // Star CTA — record click + close
  const cta = document.getElementById('star-modal-cta');
  if (cta) {
    cta.addEventListener('click', () => {
      writeState({ starred: true, starredAt: Date.now() });
      // Let the new tab open, then close the modal
      setTimeout(close, 120);
    });
  }

  // Fetch star count (best-effort, silent on failure)
  let starsFetched = false;
  function fetchStars() {
    if (starsFetched) return;
    starsFetched = true;
    fetch('https://api.github.com/repos/' + REPO, { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => {
        const count = typeof data.stargazers_count === 'number' ? data.stargazers_count : null;
        if (count == null) return;
        const box = document.getElementById('star-modal-stats');
        const num = document.getElementById('star-modal-stats-num');
        if (box && num) {
          num.textContent = count.toLocaleString();
          box.hidden = false;
        }
      })
      .catch(() => {
        /* silently skip */
      });
  }

  // Intercept download clicks — let the download proceed, then show the modal
  const DOWNLOAD_SELECTOR = 'a[href="/macos/download"], a[href="/windows/download"]';
  document.querySelectorAll(DOWNLOAD_SELECTOR).forEach((link) => {
    link.addEventListener('click', () => {
      if (!shouldShow()) return;
      // Don't preventDefault — we want the actual download to start.
      setTimeout(open, OPEN_DELAY_MS);
    });
  });

  // Expose a manual trigger for testing / future entry points
  window.__omnikeyShowStarModal = open;
})();
