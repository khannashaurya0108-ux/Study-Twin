/* ══════════════════════════════════════════════════════════════
   STUDYTWIN — MediaPipe Blink Detection Module
   Phase 3 Implementation
   
   Eye Aspect Ratio (EAR) blink detection via Face Mesh
   Integrates directly into CLI fusion (15% weight)
   Writes real blink score to Firebase for ESP32 (Phase 2 prep)
   
   Usage: Include AFTER MediaPipe CDN scripts in dashboard.html
          BlinkDetector.start() → then BlinkDetector.getScore()
══════════════════════════════════════════════════════════════ */

const BlinkDetector = (() => {

  // ── MediaPipe Face Mesh Eye Landmarks (468-point model) ────────
  // Each eye needs 6 points: p1=inner, p4=outer, p2/p3=top, p5/p6=bottom
  const LEFT_EYE  = { p1:33,  p2:160, p3:158, p4:133, p5:153, p6:144 }
  const RIGHT_EYE = { p1:362, p2:385, p3:387, p4:263, p5:373, p6:380 }

  // ── Internal State ──────────────────────────────────────────────
  let _isReady        = false   // true once calibration complete (or cam denied)
  let _isCalibrating  = false
  let _calibFrames    = 0
  let _calibEARs      = []
  let _earThreshold   = 0.23    // default before calibration
  let _consecLow      = 0       // consecutive frames below threshold
  let _blinkTimes     = []      // rolling 60s timestamps
  let _currentRate    = 13      // blink/min (normal resting = 15-20)
  let _currentScore   = 50      // 0-100 blink score for CLI
  let _currentEAR     = 0
  let _faceDetected   = false
  let _cameraGranted  = false
  let _faceMesh       = null
  let _camera         = null
  let _videoEl        = null
  let _subscribers    = []
  let _lastFBWrite    = 0

  // ── EAR Formula: (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||) ───
  const dist3d = (a, b) => Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2)

  function computeEAR(lm, eye) {
    const d26 = dist3d(lm[eye.p2], lm[eye.p6])
    const d35 = dist3d(lm[eye.p3], lm[eye.p5])
    const d14 = dist3d(lm[eye.p1], lm[eye.p4])
    if (d14 < 0.0001) return 0.25   // avoid division by zero
    return (d26 + d35) / (2 * d14)
  }

  // ── Map blink rate → 0-100 score ───────────────────────────────
  // < 10 blinks/min = high cognitive engagement/fatigue → HIGH score
  // 15-20 blinks/min = relaxed baseline → LOW score
  function rateToScore(rate) {
    return Math.max(0, Math.min(100, 8 * (12 - rate)))
  }

  // ── Face Mesh Results Handler ───────────────────────────────────
  function _onResults(results) {
    const hadFace = _faceDetected

    if (!results.multiFaceLandmarks?.length) {
      _faceDetected = false
      // No face in frame — keep current score, just update status
      _updateStatusUI()
      return
    }

    _faceDetected = true
    const lm = results.multiFaceLandmarks[0]

    const leftEAR  = computeEAR(lm, LEFT_EYE)
    const rightEAR = computeEAR(lm, RIGHT_EYE)
    const avgEAR   = (leftEAR + rightEAR) / 2
    _currentEAR    = avgEAR

    // ── Calibration ─────────────────────────────────────────────
    if (_isCalibrating) {
      _calibEARs.push(avgEAR)
      _calibFrames++
      const pct = Math.min(100, Math.round((_calibFrames / 180) * 100))
      _updateCalibUI(pct)

      if (_calibFrames >= 180) {   // ~30s at 5-6fps
        const mean = _calibEARs.reduce((a,b) => a+b, 0) / _calibEARs.length
        const variance = _calibEARs.reduce((a,b) => a+(b-mean)**2, 0) / _calibEARs.length
        const std = Math.sqrt(variance)
        // Floor at 0.12 to prevent false-positives from natural eye flutter
        _earThreshold = Math.max(0.12, mean - 0.3 * std)
        _isCalibrating = false
        _isReady = true
        console.log(`[StudyTwin Blink] EAR calibrated ✓ threshold=${_earThreshold.toFixed(4)} mean=${mean.toFixed(4)} std=${std.toFixed(4)}`)
        _updateCalibUI(100)
        document.dispatchEvent(new CustomEvent('blinkCalibrationComplete', {
          detail: { threshold: _earThreshold, mean, std }
        }))
      }
      return  // don't count blinks during calibration window
    }

    if (!_isReady) return

    // ── Blink Detection ──────────────────────────────────────────
    if (avgEAR < _earThreshold) {
      _consecLow++
    } else {
      if (_consecLow >= 2) {
        // Blink confirmed (at least 2 consecutive frames below threshold)
        _blinkTimes.push(Date.now())

        // BONUS: Dispatch blink event so Three.js brain can pulse
        document.dispatchEvent(new CustomEvent('blinkDetected', { detail: { ear: avgEAR } }))
      }
      _consecLow = 0
    }

    // Prune timestamps older than 60 seconds
    const now = Date.now()
    _blinkTimes = _blinkTimes.filter(t => now - t < 60000)

    _currentRate  = _blinkTimes.length   // events in last 60s = per minute
    _currentScore = rateToScore(_currentRate)

    // Notify all subscribers
    _broadcast()
    _writeToFirebase()
  }

  // ── Broadcast to Subscribers ────────────────────────────────────
  function _broadcast() {
    const payload = {
      blinkRate:    _currentRate,
      blinkScore:   _currentScore,
      ear:          _currentEAR,
      faceDetected: _faceDetected,
      isReady:      _isReady
    }
    _subscribers.forEach(fn => fn(payload))
    _updateDashboardUI(payload)
  }

  // ── Update All Dashboard Elements ───────────────────────────────
  function _updateDashboardUI({ blinkRate, blinkScore, ear, faceDetected, isReady }) {
    const $ = id => document.getElementById(id)

    // Metric card
    const rateEl = $('d-blink')
    if (rateEl) rateEl.textContent = blinkRate.toFixed(1)

    // Raw sensor panel
    const rawEl = $('r-blink')
    if (rawEl) rawEl.textContent = blinkRate.toFixed(1) + ' /min'

    // Bar fill (0-24 range mapped to %)
    const barEl = $('bar-blink')
    if (barEl) barEl.style.width = Math.min(100, (blinkRate / 24) * 100) + '%'

    // Status note under metric card
    const noteEl = $('d-blink-note')
    if (noteEl) {
      if      (!_cameraGranted)   noteEl.textContent = 'No camera · default score'
      else if (!faceDetected)     noteEl.textContent = '⚠ No face detected · move closer'
      else if (!isReady)          noteEl.textContent = 'Calibrating EAR baseline…'
      else if (blinkRate < 8)     noteEl.textContent = '⚠ Very low blink — high fatigue signal'
      else if (blinkRate < 12)    noteEl.textContent = '⚠ Low blink rate — cognitive load high'
      else                        noteEl.textContent = `MediaPipe ✓ EAR: ${ear.toFixed(3)}`
    }

    // EAR debug display (if element exists)
    const earEl = $('blink-ear-debug')
    if (earEl) earEl.textContent = `EAR: ${ear.toFixed(4)} | Thresh: ${_earThreshold.toFixed(4)}`

    // Face status dot
    const faceEl = $('blink-face-dot')
    if (faceEl) {
      faceEl.style.background = faceDetected ? 'var(--emerald)' : 'var(--ink4)'
      faceEl.title = faceDetected ? `Face tracked — EAR: ${ear.toFixed(3)}` : 'No face in frame'
    }

    // Camera pill in nav/status bar
    const camPill = $('camera-status-pill')
    if (camPill) {
      if (_cameraGranted && faceDetected) {
        camPill.textContent = '📷 Face Tracked'
        camPill.style.color = 'var(--emerald)'
      } else if (_cameraGranted) {
        camPill.textContent = '📷 Camera Active'
        camPill.style.color = 'var(--cobalt)'
      }
    }
  }

  // ── Status UI (no face / no cam) ────────────────────────────────
  function _updateStatusUI() {
    const noteEl = document.getElementById('d-blink-note')
    if (!noteEl) return
    if (!_cameraGranted)  noteEl.textContent = 'No camera · default score'
    else                  noteEl.textContent = '⚠ No face detected · move closer'
  }

  // ── Calibration Progress UI ─────────────────────────────────────
  function _updateCalibUI(pct) {
    const barEl = document.getElementById('calib-blink-bar')
    if (barEl) barEl.style.width = pct + '%'

    const lbl = document.getElementById('calib-blink-label')
    if (lbl) {
      lbl.textContent = pct < 100
        ? `Calibrating blink baseline… ${pct}%`
        : 'Blink calibration complete ✓'
    }
  }

  // ── Write Blink Data to Firebase (throttled 5s) ─────────────────
  function _writeToFirebase() {
    const now = Date.now()
    if (now - _lastFBWrite < 5000) return
    if (!window.firebase?.database || !window.CURRENT_UID) return
    _lastFBWrite = now

    try {
      const ref = window.firebase.database().ref(`/sessions/${window.CURRENT_UID}/live`)
      ref.update({
        blink_score: _currentScore,
        blink_rate:  _currentRate,
        blink_ear:   parseFloat(_currentEAR.toFixed(4))
      })
    } catch(e) { /* silent — blink score is non-critical */ }
  }

  // ── Request Camera Access ───────────────────────────────────────
  async function _requestCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' }
      })

      // Create hidden video element
      _videoEl = document.createElement('video')
      _videoEl.id = 'st-mediapipe-video'
      _videoEl.style.cssText = [
        'position:fixed', 'top:-9999px', 'left:-9999px',
        'width:1px', 'height:1px', 'opacity:0.001',
        'pointer-events:none', 'z-index:-1'
      ].join(';')
      _videoEl.autoplay    = true
      _videoEl.muted       = true
      _videoEl.playsInline = true
      _videoEl.srcObject   = stream
      document.body.appendChild(_videoEl)

      _cameraGranted = true
      console.log('[StudyTwin Blink] Camera access granted ✓')

      return true
    } catch (err) {
      _cameraGranted = false
      _isReady       = true  // Mark ready so CLI fusion uses default
      console.warn('[StudyTwin Blink] Camera denied:', err.message, '— using default blink score')
      _updateStatusUI()
      return false
    }
  }

  // ── Initialize MediaPipe FaceMesh ───────────────────────────────
  async function _initFaceMesh() {
    if (typeof window.FaceMesh === 'undefined') {
      console.warn('[StudyTwin Blink] FaceMesh not loaded — check CDN scripts in dashboard.html')
      _isReady = true
      return false
    }

    _faceMesh = new window.FaceMesh({
      locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/${file}`
    })

    _faceMesh.setOptions({
      maxNumFaces:            1,
      refineLandmarks:        true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence:  0.5
    })

    _faceMesh.onResults(_onResults)

    // Start processing loop
    if (typeof window.Camera !== 'undefined') {
      _camera = new window.Camera(_videoEl, {
        onFrame: async () => {
          if (_faceMesh && _videoEl && _videoEl.readyState >= 2) {
            await _faceMesh.send({ image: _videoEl })
          }
        },
        width: 640,
        height: 480
      })
      _camera.start()
      console.log('[StudyTwin Blink] MediaPipe Camera loop started ✓')
    } else {
      // Fallback: rAF loop if Camera utility not loaded
      const loop = async () => {
        if (_faceMesh && _videoEl && _videoEl.readyState >= 2) {
          await _faceMesh.send({ image: _videoEl })
        }
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
      console.log('[StudyTwin Blink] Using rAF fallback loop')
    }

    return true
  }

  // ══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════════════════════════════

  /** Call once on dashboard load. Requests camera, inits MediaPipe. */
  async function start() {
    console.log('[StudyTwin Blink] Starting…')

    const cameraOk = await _requestCamera()
    if (!cameraOk) {
      console.log('[StudyTwin Blink] Running without camera — CLI uses default blink score (50)')
      return false
    }

    // Small delay so video element initialises
    await new Promise(r => setTimeout(r, 500))

    const meshOk = await _initFaceMesh()
    if (!meshOk) return false

    console.log('[StudyTwin Blink] Ready ✓')
    return true
  }

  /**
   * Trigger EAR calibration (call at start of 60s baseline period).
   * Listens for 'blinkCalibrationComplete' event to know when done.
   */
  function startCalibration() {
    _calibEARs   = []
    _calibFrames = 0
    _isReady     = false
    _isCalibrating = true
    console.log('[StudyTwin Blink] EAR calibration started — sit still, look at screen')
    _updateCalibUI(0)
  }

  /** Subscribe to blink data. Returns unsubscribe function. */
  function subscribe(fn) {
    _subscribers.push(fn)
    // Emit current state immediately
    fn({
      blinkRate:    _currentRate,
      blinkScore:   _currentScore,
      ear:          _currentEAR,
      faceDetected: _faceDetected,
      isReady:      _isReady
    })
    return () => { _subscribers = _subscribers.filter(s => s !== fn) }
  }

  /** Get current blink score (0-100) for CLI fusion */
  const getScore       = () => _currentScore
  /** Get current blink rate (blinks per minute) */
  const getRate        = () => _currentRate
  /** True if calibration complete (or camera was denied) */
  const ready          = () => _isReady
  /** True if camera permission was granted */
  const hasCam         = () => _cameraGranted
  /** True if a face is currently being tracked */
  const isFaceTracked  = () => _faceDetected

  return { start, startCalibration, subscribe, getScore, getRate, ready, hasCam, isFaceTracked }

})()

window.BlinkDetector = BlinkDetector
console.log('[StudyTwin] blink-detection.js loaded ✓')