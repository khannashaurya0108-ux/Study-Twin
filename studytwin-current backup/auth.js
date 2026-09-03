/* ══════════════════════════════════════════════════════════════
   STUDYTWIN — Universal Authentication Module  (FAB v3)

   CHANGES vs FIXED v2:
   ✅ Removed the persistent top blue auth banner — nav widgets
      are no longer obscured on Home and Dashboard pages.
   ✅ Replaced with a floating bottom-right dropdown FAB so users
      can sign in / sign out without leaving the page.
   ✅ FAB shows user initial when signed in, person icon when not.
   ✅ Dropdown shows auth status, copyable UID, and Sign In/Out.
   ✅ Google auth popup logic unchanged.
   ✅ body padding-top is no longer forced.
══════════════════════════════════════════════════════════════ */

// Pages that require the user to be logged in
const PROTECTED_PAGES = ['dashboard'];

// ── Firebase Config ────────────────────────────────────────────
var FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBXZZ-wN2wzguf35rfPaLqm61gx0LoxIAA",
  authDomain:        "studytwin-rvce.firebaseapp.com",
  databaseURL:       "https://studytwin-rvce-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "studytwin-rvce",
  storageBucket:     "studytwin-rvce.firebasestorage.app",
  messagingSenderId: "345837599600",
  appId:             "1:345837599600:web:f2c191ab3cf7c24ca5edb5"
};

// ── Inject floating bottom-right auth FAB ──────────────────────
// A small floating button (bottom-right) with a dropdown panel
// for sign-in / sign-out. Does NOT push body content or cover nav.
(function injectAuthFAB() {
  // Don't inject on the login page
  function createFAB() {
    if (document.getElementById('st-auth-fab')) return;
    if (document.body && document.body.dataset.page === 'login') return;

    // ── Styles ────────────────────────────────────────────────
    const style = document.createElement('style');
    style.id = 'st-auth-fab-style';
    style.textContent = `
      /* ── FAB wrapper ── */
      #st-auth-fab {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 999999;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 10px;
        font-family: 'Inter', -apple-system, sans-serif;
        font-size: 13px;
      }

      /* ── Dropdown panel ── */
      #st-auth-panel {
        background: rgba(6, 13, 31, 0.97);
        border: 1px solid rgba(37, 99, 235, 0.35);
        border-radius: 14px;
        padding: 16px 18px;
        min-width: 230px;
        display: none;
        flex-direction: column;
        gap: 10px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.55);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        animation: st-fab-slide-in 0.18s ease;
      }
      #st-auth-panel.open { display: flex; }

      @keyframes st-fab-slide-in {
        from { opacity: 0; transform: translateY(8px) scale(0.97); }
        to   { opacity: 1; transform: translateY(0)  scale(1); }
      }

      /* Status row */
      #st-fab-status-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #st-fab-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #64748b;
        flex-shrink: 0;
        transition: background 0.4s;
      }
      #st-fab-label {
        color: #94a3b8;
        font-size: 13px;
        font-weight: 500;
        transition: color 0.4s;
        max-width: 170px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* UID chip */
      #st-fab-uid {
        font-family: 'JetBrains Mono', 'Courier New', monospace;
        font-size: 10px;
        color: #3b82f6;
        background: rgba(37, 99, 235, 0.1);
        border: 1px solid rgba(37, 99, 235, 0.25);
        border-radius: 6px;
        padding: 4px 10px;
        cursor: pointer;
        display: none;
        transition: background 0.2s;
        width: fit-content;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #st-fab-uid:hover { background: rgba(37, 99, 235, 0.2); }
      #st-fab-uid::before { content: 'UID: '; }

      /* Action button */
      #st-fab-btn {
        padding: 8px 0;
        border-radius: 8px;
        border: 1px solid rgba(37, 99, 235, 0.45);
        background: rgba(37, 99, 235, 0.18);
        color: #93c5fd;
        font-family: inherit;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        transition: all 0.2s;
        width: 100%;
        text-align: center;
      }
      #st-fab-btn:hover { background: rgba(37, 99, 235, 0.32); }
      #st-fab-btn.signout {
        border-color: rgba(239, 68, 68, 0.4);
        background: rgba(239, 68, 68, 0.12);
        color: #fca5a5;
      }
      #st-fab-btn.signout:hover { background: rgba(239, 68, 68, 0.26); }

      /* ── FAB trigger button ── */
      #st-auth-fab-trigger {
        width: 46px;
        height: 46px;
        border-radius: 50%;
        border: 2px solid rgba(37, 99, 235, 0.5);
        background: rgba(6, 13, 31, 0.92);
        color: #93c5fd;
        font-family: 'Inter', -apple-system, sans-serif;
        font-size: 17px;
        font-weight: 700;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 18px rgba(37, 99, 235, 0.25);
        transition: all 0.2s;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        user-select: none;
        flex-shrink: 0;
      }
      #st-auth-fab-trigger:hover {
        border-color: rgba(37, 99, 235, 0.85);
        box-shadow: 0 6px 24px rgba(37, 99, 235, 0.4);
        transform: scale(1.07);
      }
      #st-auth-fab-trigger.signed-in {
        border-color: rgba(34, 197, 94, 0.6);
        box-shadow: 0 4px 18px rgba(34, 197, 94, 0.2);
      }
      #st-auth-fab-trigger.signed-in:hover {
        box-shadow: 0 6px 24px rgba(34, 197, 94, 0.35);
      }

      /* Divider */
      .st-fab-divider {
        border: none;
        border-top: 1px solid rgba(255,255,255,0.07);
        margin: 0;
      }
    `;
    document.head.appendChild(style);

    // ── Build FAB HTML ────────────────────────────────────────
    const fab = document.createElement('div');
    fab.id = 'st-auth-fab';
    fab.innerHTML = `
      <div id="st-auth-panel">
        <div id="st-fab-status-row">
          <div id="st-fab-dot"></div>
          <span id="st-fab-label">Checking auth…</span>
        </div>
        <span id="st-fab-uid" title="Click to copy UID — paste into ESP32 config portal"></span>
        <hr class="st-fab-divider">
        <button id="st-fab-btn" class="signin">Sign In with Google</button>
      </div>
      <button id="st-auth-fab-trigger" title="Account">
        <svg id="st-fab-icon-person" width="22" height="22" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
        <span id="st-fab-initial" style="display:none;"></span>
      </button>
    `;
    document.body.appendChild(fab);

    // ── Toggle dropdown on FAB click ──────────────────────────
    const trigger = document.getElementById('st-auth-fab-trigger');
    const panel   = document.getElementById('st-auth-panel');
    trigger.addEventListener('click', function(e) {
      e.stopPropagation();
      panel.classList.toggle('open');
    });
    // Close on outside click
    document.addEventListener('click', function(e) {
      if (!fab.contains(e.target)) panel.classList.remove('open');
    });

    // ── UID click to copy ─────────────────────────────────────
    document.getElementById('st-fab-uid').addEventListener('click', function() {
      const uid = this.textContent.replace('UID: ', '').trim();
      if (!uid) return;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(uid).then(() => {
          this.title = '✅ Copied to clipboard! Paste into ESP32 config portal.';
          this.style.background = 'rgba(5, 150, 105, 0.25)';
          this.style.borderColor = 'rgba(5, 150, 105, 0.5)';
          this.style.color = '#6ee7b7';
          setTimeout(() => {
            this.style.background = '';
            this.style.borderColor = '';
            this.style.color = '';
            this.title = 'Click to copy UID — paste into ESP32 config portal';
          }, 2000);
        });
      }
    });

    // ── Sign In / Sign Out button ─────────────────────────────
    document.getElementById('st-fab-btn').addEventListener('click', function() {
      if (window.AUTH && window.AUTH.isLoggedIn) {
        window.AUTH.signOut();
      } else {
        // Trigger Google sign-in popup directly from FAB
        if (window.AUTH && typeof window.AUTH.signInWithGoogle === 'function') {
          this.textContent = 'Opening Google…';
          this.disabled = true;
          window.AUTH.signInWithGoogle()
            .catch(err => {
              console.warn('[Auth FAB] Sign-in error:', err);
              this.textContent = 'Sign In with Google';
              this.disabled = false;
            });
        } else {
          window.location.href = 'login.html';
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createFAB);
  } else {
    createFAB();
  }
})();

// ── Update the FAB state when auth changes ─────────────────────
function _updatePersistentBar(isLoggedIn, user) {
  const dot     = document.getElementById('st-fab-dot');
  const label   = document.getElementById('st-fab-label');
  const uid     = document.getElementById('st-fab-uid');
  const btn     = document.getElementById('st-fab-btn');
  const trigger = document.getElementById('st-auth-fab-trigger');
  const icon    = document.getElementById('st-fab-icon-person');
  const initial = document.getElementById('st-fab-initial');
  if (!dot) return;

  if (isLoggedIn && user) {
    // Status row
    dot.style.background  = '#22c55e';
    label.textContent     = user.displayName || user.email || 'Signed in';
    label.style.color     = '#86efac';

    // UID chip
    uid.textContent   = user.uid;
    uid.style.display = 'inline-block';

    // Action button
    btn.textContent = 'Sign Out';
    btn.className   = 'signout';
    btn.disabled    = false;

    // FAB trigger — show user initial
    const name = user.displayName || user.email || '?';
    const char = name.charAt(0).toUpperCase();
    if (icon)    icon.style.display    = 'none';
    if (initial) { initial.textContent = char; initial.style.display = 'inline'; }
    if (trigger) trigger.classList.add('signed-in');
    if (trigger) trigger.title = 'Signed in as ' + (user.displayName || user.email);
  } else {
    // Status row
    dot.style.background  = '#ef4444';
    label.textContent     = 'Not signed in';
    label.style.color     = '#fca5a5';

    // UID chip
    uid.style.display = 'none';

    // Action button
    btn.textContent = 'Sign In with Google';
    btn.className   = 'signin';
    btn.disabled    = false;

    // FAB trigger — show person icon
    if (icon)    icon.style.display    = '';
    if (initial) initial.style.display = 'none';
    if (trigger) trigger.classList.remove('signed-in');
    if (trigger) trigger.title = 'Sign in to your account';
  }
}

// ── Update the nav Sign In / Sign Out button (from app.js) ─────
// Retries for up to 3 seconds in case renderNav() hasn't run yet
function _updateNavButton(isLoggedIn, user) {
  let tries = 0;
  const tryUpdate = () => {
    const btn = document.querySelector('[data-auth-btn]');
    if (btn) {
      btn.textContent       = isLoggedIn ? 'Sign Out' : 'Sign In';
      btn.title             = isLoggedIn ? ('Signed in as ' + (user.displayName || user.email)) : 'Sign in with Google';
      btn.style.borderColor = isLoggedIn ? '#059669' : '';
      btn.style.color       = isLoggedIn ? '#059669' : '';
      btn.onclick           = isLoggedIn
        ? () => window.AUTH.signOut()
        : () => { window.location.href = 'login.html'; };

      // Update user name pill if present
      const nameEl = document.getElementById('nav-user-name');
      if (nameEl) {
        nameEl.textContent   = (isLoggedIn && user) ? (user.displayName || user.email || '') : '';
        nameEl.style.display = isLoggedIn ? 'flex' : 'none';
      }
    } else if (++tries < 15) {
      setTimeout(tryUpdate, 200); // retry every 200ms for 3s
    }
  };
  tryUpdate();
}

// ── Main AUTH object ───────────────────────────────────────────
window.AUTH = {
  isInitialized: false,
  isLoggedIn:    false,
  currentUser:   null,

  init() {
    if (this.isInitialized) return;
    this.isInitialized = true;
    this._loadFirebaseAndSetup();
  },

  _loadFirebaseAndSetup() {
    const CDN = 'https://www.gstatic.com/firebasejs/8.10.1/';
    const SCRIPTS = [
      CDN + 'firebase-app.js',
      CDN + 'firebase-auth.js',
      CDN + 'firebase-database.js'
    ];

    const loadScript = (src) => new Promise((resolve) => {
      // If this exact script tag is already in the DOM, just wait for firebase obj
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const s   = document.createElement('script');
      s.src     = src;
      s.onload  = resolve;
      s.onerror = () => { console.warn('[Auth] Could not load:', src); resolve(); };
      document.head.appendChild(s);
    });

    // Load all three scripts in sequence (not parallel) to avoid init ordering issues
    loadScript(SCRIPTS[0])
      .then(() => loadScript(SCRIPTS[1]))
      .then(() => loadScript(SCRIPTS[2]))
      .then(() => {
        // Wait up to 3s for window.firebase to actually be defined
        let tries = 0;
        const waitForFirebase = () => {
          if (window.firebase) {
            this._initFirebaseAuth();
          } else if (tries++ < 30) {
            setTimeout(waitForFirebase, 100);
          } else {
            console.error('[Auth] Firebase SDK did not load in time');
          }
        };
        waitForFirebase();
      });
  },

  _initFirebaseAuth() {
    if (!window.firebase.apps.length) {
      window.firebase.initializeApp(FIREBASE_CONFIG);
    }

    const auth = window.firebase.auth();
    auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL);

    auth.onAuthStateChanged((user) => {
      this._handleAuthChange(user);
    });
  },

  _handleAuthChange(user) {
    const page        = document.body ? (document.body.dataset.page || 'index') : 'index';
    const isProtected = PROTECTED_PAGES.includes(page);

    if (user) {
      // ── LOGGED IN ───────────────────────────────────────────
      this.isLoggedIn    = true;
      this.currentUser   = user;
      window.CURRENT_UID = user.uid;

      console.group('%c[StudyTwin Auth] ✅ SIGNED IN', 'color:#22c55e;font-weight:bold;font-size:13px');
      console.log('Email:', user.email);
      console.log('%cUID: ' + user.uid, 'color:#3b82f6;font-weight:bold;font-size:13px');
      console.log('%c↑ IMPORTANT: This UID must exactly match the UID you entered in the ESP32 config portal', 'color:#f59e0b;font-weight:bold');
      console.groupEnd();

      _updatePersistentBar(true, user);
      _updateNavButton(true, user);

      // Tell app.js
      if (typeof window.updateAuthNav === 'function') window.updateAuthNav(true, user);

      if (page === 'login') window.location.href = 'dashboard.html';

    } else {
      // ── LOGGED OUT ──────────────────────────────────────────
      this.isLoggedIn    = false;
      this.currentUser   = null;
      window.CURRENT_UID = null;

      console.log('%c[StudyTwin Auth] ❌ Not signed in. Visit /login.html to sign in.', 'color:#ef4444');

      _updatePersistentBar(false, null);
      _updateNavButton(false, null);

      if (typeof window.updateAuthNav === 'function') window.updateAuthNav(false, null);

      if (isProtected) window.location.href = 'login.html';
    }
  },

  signInWithGoogle() {
    if (!window.firebase || !window.firebase.auth) {
      return Promise.reject(new Error('Firebase not ready. Please refresh.'));
    }
    const provider = new window.firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    provider.addScope('profile');
    provider.addScope('email');
    return window.firebase.auth().signInWithPopup(provider);
  },

  signOut() {
    if (!window.firebase || !window.firebase.auth) return;
    window.firebase.auth().signOut()
      .then(() => {
        window.CURRENT_UID     = null;
        window._sessionStartMs = null;
        window.location.href   = 'login.html';
      })
      .catch(err => console.error('[Auth] Sign-out error:', err));
  }
};

// ── Auto-initialize ─────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.AUTH.init());
} else {
  window.AUTH.init();
}