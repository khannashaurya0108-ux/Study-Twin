/**
 * StudyTwin Blink Detection — Socket.IO Client
 * Connects to blink_server.py (localhost:5001)
 * Replaces MediaPipe JS (which caused latency)
 *
 * Exposes:
 *   window.BLINK_SCORE      (0-100, used in CLI fusion at 15% weight)
 *   window.BLINK_RATE       (blinks per minute)
 *   window.BLINK_COUNT      (total this session)
 *   window.BLINK_EAR        (raw Eye Aspect Ratio)
 *   window.BLINK_CALIBRATED (true after 5s calibration)
 *   window.BLINK_CONNECTED  (true when server is reachable)
 *   window.resetBlinkCount() (call to reset session)
 */

(function () {
  'use strict';

  const BLINK_SERVER   = 'http://127.0.0.1:5001';
  const FALLBACK_SCORE = 50;           // neutral value when server is offline
  const SOCKET_IO_CDN  =
    'https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.2/socket.io.min.js';

  // ── Globals read by app.js ─────────────────────────────────────────────
  window.BLINK_SCORE      = FALLBACK_SCORE;
  window.BLINK_RATE       = 15;
  window.BLINK_COUNT      = 0;
  window.BLINK_EAR        = 0.30;
  window.BLINK_CALIBRATED = false;
  window.BLINK_CONNECTED  = false;

  // ── Load Socket.IO client (CDN), then connect ──────────────────────────
  function bootstrap() {
    if (window.io) {
      connectToServer();
      return;
    }
    const script   = document.createElement('script');
    script.src     = SOCKET_IO_CDN;
    script.onload  = connectToServer;
    script.onerror = function () {
      console.warn('[BLINK] Socket.IO CDN unreachable — using fallback score 50');
      // Globals already set to fallback; CLI fusion will still work
    };
    document.head.appendChild(script);
  }

  // ── Socket.IO connection ───────────────────────────────────────────────
  function connectToServer() {
    const socket = window.io(BLINK_SERVER, {
      transports:           ['websocket', 'polling'],
      reconnectionDelay:    2000,
      reconnectionAttempts: Infinity,
      timeout:              5000,
    });

    socket.on('connect', function () {
      window.BLINK_CONNECTED = true;
      console.log('[BLINK] Connected to blink_server.py on port 5001');
      _setStatusBadge(true);
    });

    socket.on('disconnect', function () {
      window.BLINK_CONNECTED = false;
      window.BLINK_SCORE     = FALLBACK_SCORE;
      console.warn('[BLINK] Server disconnected — blink score set to fallback 50');
      _setStatusBadge(false);
    });

    // ── Main data handler ──────────────────────────────────────────────
    socket.on('blink_data', function (data) {
      // Update globals (app.js CLI fusion reads these)
      window.BLINK_SCORE      = (typeof data.blink_score === 'number')
                                  ? data.blink_score : FALLBACK_SCORE;
      window.BLINK_RATE       = data.blink_rate   || 0;
      window.BLINK_COUNT      = data.blink_count  || 0;
      window.BLINK_EAR        = data.ear          || 0.30;
      window.BLINK_CALIBRATED = data.calibrated   || false;

      // Update any dashboard UI elements that exist
      _updateUI(data);
    });

    // ── Expose reset to session-start logic ──────────────────────────
    window.resetBlinkCount = function () {
      socket.emit('reset_blinks');
      window.BLINK_COUNT = 0;
      console.log('[BLINK] Session reset sent');
    };
  }

  // ── Optional UI updates (only runs if elements exist in dashboard.html) ─
  function _updateUI(data) {
    var rateEl  = document.getElementById('blink-rate-val');
    var countEl = document.getElementById('blink-count-val');
    var earEl   = document.getElementById('blink-ear-val');
    var calibEl = document.getElementById('blink-calibration-status');

    if (rateEl)  rateEl.textContent  = data.blink_rate + ' /min';
    if (countEl) countEl.textContent = data.blink_count;
    if (earEl)   earEl.textContent   = data.ear;

    if (calibEl) {
      calibEl.textContent = data.calibrated ? 'Calibrated ✓' : 'Calibrating…';
      calibEl.style.color = data.calibrated ? '#10B981' : '#F59E0B';
    }
  }

  function _setStatusBadge(online) {
    var badge = document.getElementById('blink-server-status');
    if (!badge) return;
    badge.textContent = online ? '● LIVE' : '○ Offline';
    badge.style.color = online ? '#10B981' : '#EF4444';
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

}());