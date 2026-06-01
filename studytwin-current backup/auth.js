/* ══════════════════════════════════════════════════════════════
   STUDYTWIN — Universal Authentication Module
   Only DASHBOARD is protected. All other pages are public.
   Manages global auth state, nav login/logout, and redirects.
══════════════════════════════════════════════════════════════ */

// Pages that require the user to be logged in
const PROTECTED_PAGES = ['dashboard'];

// ── FIREBASE CONFIG ────────────────────────────────────────────
var FIREBASE_CONFIG = {
  apiKey: "AIzaSyBXZZ-wN2wzguf35rfPaLqm61gx0LoxIAA",
  authDomain: "studytwin-rvce.firebaseapp.com",
  databaseURL: "https://studytwin-rvce-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "studytwin-rvce",
  storageBucket: "studytwin-rvce.firebasestorage.app",
  messagingSenderId: "345837599600",
  appId: "1:345837599600:web:f2c191ab3cf7c24ca5edb5"
};

// ── GLOBAL AUTH STATE ──────────────────────────────────────────
window.AUTH = {
  isInitialized: false,
  isLoggedIn: false,
  currentUser: null,

  init() {
    if (this.isInitialized) return;
    this.isInitialized = true;
    this._loadFirebase();
  },

  _loadFirebase() {
    const loadScript = (src) => new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });

    Promise.all([
      loadScript('https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js'),
      loadScript('https://www.gstatic.com/firebasejs/8.10.1/firebase-database.js'),
      loadScript('https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js')
    ]).then(() => {
      this._initializeFirebase();
    }).catch(err => {
      console.error('[Auth] Firebase SDK load failed:', err);
    });
  },

  _initializeFirebase() {
    if (!window.firebase) {
      console.error('[Auth] Firebase SDK not loaded');
      return;
    }

    // Initialize Firebase only once
    if (!window.firebase.apps.length) {
      window.firebase.initializeApp(FIREBASE_CONFIG);
    }

    const auth = window.firebase.auth();
    auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL);

    // Listen for auth state changes on all pages
    auth.onAuthStateChanged(user => {
      this._handleAuthStateChange(user);
    });
  },

  _handleAuthStateChange(user) {
    const currentPage = document.body.dataset.page || 'index';
    const isProtected = PROTECTED_PAGES.includes(currentPage);

    if (user) {
      // ── User is logged in ──
      this.isLoggedIn = true;
      this.currentUser = user;
      window.CURRENT_UID = user.uid;
      console.log('[Auth] Signed in:', user.email);

      // Update nav button
      if (window.updateAuthNav) window.updateAuthNav(true, user);

      // If we're on login page and already logged in → go to dashboard
      if (currentPage === 'login') {
        window.location.href = 'dashboard.html';
      }

    } else {
      // ── User is logged out ──
      this.isLoggedIn = false;
      this.currentUser = null;
      window.CURRENT_UID = null;
      console.log('[Auth] Signed out');

      // Update nav button
      if (window.updateAuthNav) window.updateAuthNav(false, null);

      // If on a protected page, redirect to login
      if (isProtected) {
        window.location.href = 'login.html';
      }
    }
  },

  // ── Sign in with Google popup ──
  signInWithGoogle() {
    if (!window.firebase || !window.firebase.auth) {
      console.error('[Auth] Firebase not ready');
      return Promise.reject(new Error('Firebase not ready'));
    }
    const provider = new window.firebase.auth.GoogleAuthProvider();
    return window.firebase.auth().signInWithPopup(provider);
  },

  // ── Sign out and go home ──
  signOut() {
    if (!window.firebase || !window.firebase.auth) return;
    window.firebase.auth().signOut().then(() => {
      window.CURRENT_UID = null;
      window._sessionStartMs = null;
      window.location.href = 'index.html';
    }).catch(err => {
      console.error('[Auth] Sign-out error:', err);
    });
  }
};

// ── AUTO-INITIALIZE AUTH ON PAGE LOAD ──────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.AUTH.init());
} else {
  window.AUTH.init();
}
