/* ══════════════════════════════════════════════════════════════
   STUDYTWIN — Universal Authentication Module  (FIXED v2)
   
   WHAT IS FIXED vs the original:
   ✅ A permanent Sign-In / Sign-Out bar is injected at the top of
      EVERY page — you can always see your auth state and UID.
   ✅ Your UID is shown in the bar — copy it to the ESP32 config portal.
   ✅ Retry logic: even if nav is rendered AFTER Firebase resolves,
      the Sign In / Sign Out button still updates correctly.
   ✅ Firebase SDK loading is more robust — waits if SDK is already
      being loaded by dashboard.html script tags.
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

// ── Inject persistent auth bar at the very top of every page ───
// This bar is ALWAYS visible regardless of navigation state.
(function injectPersistentAuthBar() {
  // Don't inject on the login page (it has its own UI)
  // We check at DOM ready because body.dataset isn't available yet here
  function createBar() {
    if (document.getElementById('st-persistent-auth-bar')) return;
    if (document.body && document.body.dataset.page === 'login') return;

    // CSS for the bar
    const style = document.createElement('style');
    style.id = 'st-auth-bar-style';
    style.textContent = `
      #st-persistent-auth-bar {
        position: fixed;
        top: 0; left: 0; right: 0;
        z-index: 999999;
        height: 38px;
        background: rgba(6, 13, 31, 0.97);
        border-bottom: 1px solid rgba(37, 99, 235, 0.3);
        display: flex;
        align-items: center;
        justify-content: flex-end;
        padding: 0 20px;
        gap: 14px;
        font-family: 'Inter', -apple-system, sans-serif;
        font-size: 12px;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
      }
      #st-auth-bar-status {
        display: flex;
        align-items: center;
        gap: 7px;
        color: #94a3b8;
      }
      #st-auth-bar-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #64748b;
        flex-shrink: 0;
        transition: background 0.4s;
      }
      #st-auth-bar-label {
        color: #94a3b8;
        transition: color 0.4s;
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #st-auth-bar-uid {
        font-family: 'JetBrains Mono', 'Courier New', monospace;
        font-size: 10px;
        color: #3b82f6;
        background: rgba(37, 99, 235, 0.1);
        border: 1px solid rgba(37, 99, 235, 0.25);
        border-radius: 4px;
        padding: 2px 8px;
        cursor: pointer;
        display: none;
        transition: background 0.2s;
      }
      #st-auth-bar-uid:hover {
        background: rgba(37, 99, 235, 0.2);
      }
      #st-auth-bar-uid::before { content: 'UID: '; }
      #st-auth-bar-btn {
        padding: 5px 14px;
        border-radius: 6px;
        border: 1px solid rgba(37, 99, 235, 0.4);
        background: rgba(37, 99, 235, 0.15);
        color: #93c5fd;
        font-family: inherit;
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
        letter-spacing: 0.05em;
        transition: all 0.2s;
        text-transform: uppercase;
      }
      #st-auth-bar-btn:hover { background: rgba(37, 99, 235, 0.3); }
      #st-auth-bar-btn.signout {
        border-color: rgba(239, 68, 68, 0.4);
        background: rgba(239, 68, 68, 0.1);
        color: #fca5a5;
      }
      #st-auth-bar-btn.signout:hover { background: rgba(239, 68, 68, 0.25); }
      /* Push page content down so bar doesn't overlap nav */
      body { padding-top: 38px !important; }
    `;
    document.head.appendChild(style);

    // Build the bar HTML
    const bar = document.createElement('div');
    bar.id = 'st-persistent-auth-bar';
    bar.innerHTML = `
      <div id="st-auth-bar-status">
        <div id="st-auth-bar-dot"></div>
        <span id="st-auth-bar-label">Checking auth…</span>
      </div>
      <span id="st-auth-bar-uid" title="Click to copy UID — you need this for ESP32 config portal"></span>
      <button id="st-auth-bar-btn" class="signin">Sign In</button>
    `;

    // Insert as very first element in body
    if (document.body.firstChild) {
      document.body.insertBefore(bar, document.body.firstChild);
    } else {
      document.body.appendChild(bar);
    }

    // UID click to copy
    document.getElementById('st-auth-bar-uid').addEventListener('click', function() {
      const uid = this.textContent.replace('UID: ', '').trim();
      if (!uid) return;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(uid).then(() => {
          const orig = this.textContent;
          this.textContent = 'UID: ' + uid; // keep same with "Copied!" appended via title
          this.title = '✅ Copied to clipboard! Paste this into ESP32 config portal.';
          setTimeout(() => { this.title = 'Click to copy UID — you need this for ESP32 config portal'; }, 3000);
          // Flash effect
          this.style.background = 'rgba(5, 150, 105, 0.25)';
          this.style.borderColor = 'rgba(5, 150, 105, 0.5)';
          this.style.color = '#6ee7b7';
          setTimeout(() => {
            this.style.background = '';
            this.style.borderColor = '';
            this.style.color = '';
          }, 2000);
        });
      }
    });

    // Button click handler
    document.getElementById('st-auth-bar-btn').addEventListener('click', function() {
      if (window.AUTH && window.AUTH.isLoggedIn) {
        window.AUTH.signOut();
      } else {
        window.location.href = 'login.html';
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createBar);
  } else {
    createBar();
  }
})();

// ── Update the persistent auth bar ─────────────────────────────
function _updatePersistentBar(isLoggedIn, user) {
  const dot   = document.getElementById('st-auth-bar-dot');
  const label = document.getElementById('st-auth-bar-label');
  const uid   = document.getElementById('st-auth-bar-uid');
  const btn   = document.getElementById('st-auth-bar-btn');
  if (!dot) return;

  if (isLoggedIn && user) {
    dot.style.background = '#22c55e';
    label.textContent    = user.displayName || user.email || 'Signed in';
    label.style.color    = '#86efac';
    uid.textContent      = user.uid;
    uid.style.display    = 'block';
    uid.title            = 'Click to copy UID — paste this into ESP32 config portal';
    btn.textContent      = 'Sign Out';
    btn.className        = 'signout';
  } else {
    dot.style.background = '#ef4444';
    label.textContent    = 'Not signed in';
    label.style.color    = '#fca5a5';
    uid.style.display    = 'none';
    btn.textContent      = 'Sign In';
    btn.className        = 'signin';
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
        // Script tag exists — Firebase might already be loaded
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
        window.location.href   = 'index.html';
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