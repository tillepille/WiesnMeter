// WiesnMeter Frontend Logic
(function () {
  'use strict';

  // Elements
  const userNav = document.getElementById('user-nav');
  const userAvatar = document.getElementById('user-avatar');
  const userName = document.getElementById('user-name');
  const logoutBtn = document.getElementById('logout-btn');

  const loggedOutView = document.getElementById('logged-out-view');
  const loggedInView = document.getElementById('logged-in-view');
  const devLoginContainer = document.getElementById('dev-login-container');
  const devLoginForm = document.getElementById('dev-login-form');
  const devUsernameInput = document.getElementById('dev-username');

  const btnAddMass = document.getElementById('btn-add-mass');
  const btnAddSchnaps = document.getElementById('btn-add-schnaps');

  const massCountEl = document.getElementById('mass-count');
  const schnapsCountEl = document.getElementById('schnaps-count');
  const totalDrinksEl = document.getElementById('total-drinks');

  const toastEl = document.getElementById('toast');
  const telemetryLog = document.getElementById('telemetry-log');

  let currentUser = null;
  let toastTimeout = null;

  // Show Toast notification
  function showToast(message, isError = false) {
    if (toastTimeout) {
      clearTimeout(toastTimeout);
    }
    toastEl.textContent = message;
    toastEl.classList.remove('hidden', 'error');
    if (isError) {
      toastEl.classList.add('error');
    }
    toastTimeout = setTimeout(() => {
      toastEl.classList.add('hidden');
    }, 3500);
  }

  // Append OpenTelemetry log entry
  function appendTelemetryLog(username, type) {
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `
      <span class="log-time">${time}</span>
      <span class="log-msg">OTEL EXPORT: drinks_total +1 { username: "${escapeHtml(username)}", type: "${escapeHtml(type)}" }</span>
    `;
    telemetryLog.prepend(entry);

    // Keep log max 10 entries
    while (telemetryLog.children.length > 10) {
      telemetryLog.removeChild(telemetryLog.lastChild);
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Update session scoreboard
  function updateStats(stats) {
    if (!stats) return;
    const beer = stats.beer || 0;
    const schnaps = stats.schnaps || 0;
    const total = beer + schnaps;

    massCountEl.textContent = beer;
    schnapsCountEl.textContent = schnaps;
    totalDrinksEl.textContent = total;
  }

  // Render Logged In state
  function renderLoggedIn(user, stats) {
    currentUser = user;
    userAvatar.src = user.avatar_url || 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png';
    userName.textContent = `@${user.username}`;

    userNav.classList.remove('hidden');
    loggedInView.classList.remove('hidden');
    loggedOutView.classList.add('hidden');

    updateStats(stats);
  }

  // Render Logged Out state
  function renderLoggedOut(config) {
    currentUser = null;
    userNav.classList.add('hidden');
    loggedInView.classList.add('hidden');
    loggedOutView.classList.remove('hidden');

    if (config && config.devMode) {
      devLoginContainer.classList.remove('hidden');
    }
  }

  // Track a drink
  async function trackDrink(type) {
    if (!currentUser) return;

    const btn = type === 'beer' || type === 'mass' ? btnAddMass : btnAddSchnaps;
    btn.disabled = true;

    try {
      const res = await fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to record drink');
      }

      showToast(data.message || 'Drink recorded!');
      updateStats(data.data.stats);
      appendTelemetryLog(data.data.username, data.data.type);
    } catch (err) {
      console.error('Track error:', err);
      showToast(err.message, true);
    } finally {
      setTimeout(() => {
        btn.disabled = false;
      }, 200);
    }
  }

  // Setup event listeners
  btnAddMass.addEventListener('click', () => trackDrink('beer'));
  btnAddSchnaps.addEventListener('click', () => trackDrink('schnaps'));

  logoutBtn.addEventListener('click', async () => {
    try {
      await fetch('/logout', { method: 'POST' });
      window.location.reload();
    } catch (err) {
      console.error('Logout error:', err);
    }
  });

  devLoginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = devUsernameInput.value.trim() || 'wiesn_fan';
    try {
      const res = await fetch('/login/dev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const data = await res.json();
      if (data.success) {
        checkAuth();
      }
    } catch (err) {
      console.error('Dev login error:', err);
      showToast('Dev login failed', true);
    }
  });

  // Check current auth & config
  async function checkAuth() {
    try {
      const [configRes, meRes] = await Promise.all([
        fetch('/api/config').then((r) => r.json()),
        fetch('/api/me').then((r) => r.json()),
      ]);

      if (meRes.authenticated && meRes.user) {
        renderLoggedIn(meRes.user, meRes.stats);
      } else {
        renderLoggedOut(configRes);
      }
    } catch (err) {
      console.error('Auth check error:', err);
      renderLoggedOut({ devMode: true });
    }
  }

  // Initialize
  checkAuth();
})();
