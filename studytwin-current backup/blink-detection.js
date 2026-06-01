/* ══════════════════════════════════════════════════════════════
   STUDYTWIN — MediaPipe Blink Detection Module  (Phase 2 Update)
   
   KEY CHANGE vs previous version:
   _writeToFirebase() now writes to:
     /sessions/{uid}/live/current/blink_rate    ← ESP32 reads this for OLED
     /sessions/{uid}/live/current/blink_score   ← Dashboard CLI fusion
     /sessions/{uid}/live/current/blink_ear     ← Debug
   
   Previously it wrote to /sessions/{uid}/live (wrong path).
   Now it writes to /sessions/{uid}/live/current to match
   the canonical schema where ESP32 also writes every 1s.
   
   The ESP32 reads blink_rate every 15s from this path and
   displays "BL: XX/m" on the OLED.
══════════════════════════════════════════════════════════════ */

const BlinkDetector = (() => {

  // ── Eye landmark indices (pixel-space EAR, matches blink_server.py) ──
  const LEFT_EYE  = [362, 380, 374, 263, 386, 385]
  const RIGHT_EYE = [33,  159, 158, 133, 153, 145]

  // ── State ──
  let _isReady       = false
  let _isCalibrating = false
  let _calibFrames   = 0
  let _calibEARs     = []
  let _earThreshold  = 0.285
  let _earBaseline   = 0.30
  let _consecLow     = 0
  let _totalBlinks   = 0
  let _countStartTime= 0
  let _currentRate   = 0
  let _currentScore  = 50
  let _currentEAR    = 0
  let _smoothedEAR   = -1           // -1 = uninitialized
  let _lastBlinkTime = 0
  let _faceDetected  = false
  let _cameraGranted = false
  let _faceMesh      = null
  let _videoEl       = null
  let _externalVideo = false
  let _subscribers   = []
  let _lastFBWrite   = 0            // throttle Firebase writes
  let _frameCount    = 0

  // ── Pixel-space EAR (matches Python blink_server.py exactly) ──
  function computeEAR(lm, eyeIndices, w, h) {
    const px = (idx) => [lm[idx].x * w, lm[idx].y * h]
    const p1 = px(eyeIndices[0]), p2 = px(eyeIndices[1])
    const p3 = px(eyeIndices[2]), p4 = px(eyeIndices[3])
    const p5 = px(eyeIndices[4]), p6 = px(eyeIndices[5])
    const dist = (a, b) => Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2)
    const A = dist(p2, p6)
    const B = dist(p3, p5)
    const C = dist(p1, p4)
    return C < 1e-6 ? 0.30 : (A + B) / (2.0 * C)
  }

  // ── Score formula (matches Python blink_rate_to_score) ──
  function rateToScore(bpm) {
    if (bpm <= 0) return 0
    return Math.max(0, Math.min(100, Math.round(100 - Math.abs(bpm - 15) * 8)))
  }

  // ── Process one FaceMesh result frame ──
  function _onResults(results) {
    _frameCount++

    if (!results.multiFaceLandmarks?.length) {
      _faceDetected = false
      _broadcast()
      return
    }

    _faceDetected = true

    if (!_isCalibrating && !_isReady) {
      startCalibration()
    }

    const lm = results.multiFaceLandmarks[0]
    const w  = (_videoEl && _videoEl.videoWidth)  || 640
    const h  = (_videoEl && _videoEl.videoHeight) || 480

    const leftEAR  = computeEAR(lm, LEFT_EYE,  w, h)
    const rightEAR = computeEAR(lm, RIGHT_EYE, w, h)
    const rawEAR   = (leftEAR + rightEAR) / 2.0

    // EMA smoothing
    const EMA_ALPHA = 0.4
    if (_smoothedEAR < 0) _smoothedEAR = rawEAR
    _smoothedEAR = _smoothedEAR * (1 - EMA_ALPHA) + rawEAR * EMA_ALPHA
    _currentEAR  = _smoothedEAR

    // ── Calibration phase ──
    if (_isCalibrating) {
      _calibEARs.push(rawEAR)
      _calibFrames++
      const pct = Math.min(100, Math.round((_calibFrames / 180) * 100))
      _updateCalibUI(pct)

      if (_calibFrames >= 180) {
        _calibEARs.sort((a, b) => a - b)
        _earBaseline  = _calibEARs[Math.floor(_calibEARs.length * 0.6)]
        _earThreshold = Math.max(0.18, Math.min(0.35, _earBaseline * 0.75))

        _isCalibrating   = false
        _isReady         = true
        _countStartTime  = Date.now()
        _smoothedEAR     = _earBaseline

        console.log(`[StudyTwin Blink] Calibrated ✓  baseline=${_earBaseline.toFixed(4)}  threshold=${_earThreshold.toFixed(4)}  video=${w}x${h}`)

        _updateCalibUI(100)
        const mean = _calibEARs.reduce((a, b) => a + b, 0) / _calibEARs.length
        document.dispatchEvent(new CustomEvent('blinkCalibrationComplete', {
          detail: { threshold: _earThreshold, mean, std: 0 }
        }))
      }
      _broadcast()
      return
    }

    if (!_isReady) return

    // ── Blink detection ──
    const now = Date.now()

    if (_smoothedEAR < _earThreshold) {
      _consecLow++
    } else {
      if (_consecLow >= 3 && (now - _lastBlinkTime) > 300) {
        _totalBlinks++
        _lastBlinkTime = now
        document.dispatchEvent(new CustomEvent('blinkDetected', { detail: { ear: _smoothedEAR } }))
      }
      _consecLow = 0
    }

    // ── Rate calculation ──
    const elapsedMinutes = Math.max((now - _countStartTime) / 60000, 1 / 60)
    _currentRate  = Math.round((_totalBlinks / elapsedMinutes) * 10) / 10
    _currentScore = rateToScore(_currentRate)

    _broadcast()
    _writeToFirebase()
  }

  function _broadcast() {
    const payload = {
      blinkRate:    _currentRate,
      blinkScore:   _currentScore,
      ear:          _currentEAR,
      faceDetected: _faceDetected,
      isReady:      _isReady,
      cameraGranted:_cameraGranted,
      earThreshold: _earThreshold
    }
    _subscribers.forEach(fn => fn(payload))
    document.dispatchEvent(new CustomEvent('blinkUpdate', { detail: payload }))
  }

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

  // ── Firebase write ────────────────────────────────────────────
  // Writes to /sessions/{uid}/live/current  (same node ESP32 uses)
  // Fields written:
  //   blink_rate  → ESP32 reads this to show "BL: XX/m" on OLED
  //   blink_score → Dashboard CLI fusion uses this
  //   blink_ear   → Debug value
  //
  // Throttled to once every 3 seconds (Firebase free tier safe).
  // Uses firebase.database().ref().update() to MERGE with ESP32 data,
  // NOT overwrite – so ESP32 fields (gsr_raw, rmssd, etc.) stay intact.
  function _writeToFirebase() {
    const now = Date.now()
    if (now - _lastFBWrite < 3000) return               // throttle: max 1 write / 3s
    if (!window.firebase?.database || !window.CURRENT_UID) return
    _lastFBWrite = now

    try {
      // Use .update() not .set() — this MERGES blink fields into the
      // existing node that ESP32 already wrote gsr/hrv/cli into.
      // If we used .set() we would wipe ESP32's data.
      const ref = window.firebase.database()
                    .ref(`/sessions/${window.CURRENT_UID}/live/current`)
      ref.update({
        blink_rate:  parseFloat(_currentRate.toFixed(1)),
        blink_score: _currentScore,
        blink_ear:   parseFloat(_currentEAR.toFixed(4))
      }).then(() => {
        // silent success
      }).catch(err => {
        // Only log first few errors to avoid console spam
        if (_frameCount < 20) console.warn('[StudyTwin Blink] Firebase write error:', err.message)
      })
    } catch (e) { /* silent */ }
  }

  // ── Accept external video element (avoids dual camera streams) ──
  function acceptVideo(videoElement) {
    if (!videoElement || !(videoElement instanceof HTMLVideoElement)) {
      console.warn('[StudyTwin Blink] acceptVideo: invalid element')
      return false
    }
    _videoEl       = videoElement
    _externalVideo = true
    _cameraGranted = true
    console.log('[StudyTwin Blink] Using external video element:', videoElement.id || '(no id)')
    return true
  }

  // ── Camera request (no facingMode – virtual camera compatible) ──
  async function _requestCamera() {
    if (_externalVideo && _videoEl) {
      _cameraGranted = true
      console.log('[StudyTwin Blink] Skipping camera request – using external video')
      return true
    }

    try {
      let preferredDeviceId = null
      try {
        const devices     = await navigator.mediaDevices.enumerateDevices()
        const videoDevices= devices.filter(d => d.kind === 'videoinput')
        console.log('[StudyTwin Blink] Found cameras:', videoDevices.map(d => d.label || d.deviceId))

        const virtual = videoDevices.find(d =>
          /obs|droid|virtual|cam link|elgato|snap|mmhmm|manycam|iriun|epoc|xsplit/i.test(d.label)
        )
        if (virtual?.deviceId) preferredDeviceId = virtual.deviceId
        else if (videoDevices.length > 0 && videoDevices[0].deviceId) preferredDeviceId = videoDevices[0].deviceId
      } catch (enumErr) { /* ignore */ }

      const constraintsList = []
      if (preferredDeviceId) {
        constraintsList.push({ video: { deviceId: { exact: preferredDeviceId }, width: { ideal: 640 }, height: { ideal: 480 } } })
        constraintsList.push({ video: { deviceId: { exact: preferredDeviceId } } })
      }
      constraintsList.push({ video: { width: { ideal: 640 }, height: { ideal: 480 } } })
      constraintsList.push({ video: true })

      let stream    = null
      let lastError = null

      for (const constraints of constraintsList) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints)
          console.log('[StudyTwin Blink] Camera obtained')
          break
        } catch (err) {
          lastError = err
          if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') break
        }
      }

      if (!stream) throw lastError || new Error('All camera attempts failed')

      // Create hidden video element – kept on screen at 1px so browser
      // doesn't throttle decoding (zero-size elements get throttled in 2025+ browsers)
      _videoEl = document.createElement('video')
      _videoEl.id         = 'st-mediapipe-video'
      _videoEl.setAttribute('width',  '640')
      _videoEl.setAttribute('height', '480')
      _videoEl.style.cssText = [
        'position:fixed', 'top:0', 'left:0',
        'width:1px', 'height:1px',
        'opacity:0.01',
        'pointer-events:none',
        'z-index:-9999',
        'clip:rect(0,1px,1px,0)',
        'overflow:hidden'
      ].join(';')
      _videoEl.autoplay   = true
      _videoEl.muted      = true
      _videoEl.playsInline= true
      _videoEl.srcObject  = stream
      document.body.appendChild(_videoEl)
      try { await _videoEl.play() } catch (e) { /* autoplay handles it */ }

      _cameraGranted = true
      console.log('[StudyTwin Blink] Camera access granted ✓')
      return true

    } catch (err) {
      _cameraGranted = false
      _isReady       = true   // use default score (50)
      console.warn('[StudyTwin Blink] Camera denied:', err.name, err.message)
      _broadcast()
      return false
    }
  }

  // ── Dynamic MediaPipe loader ──
  function _loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return }
      const s = document.createElement('script')
      s.src         = src
      s.crossOrigin = 'anonymous'
      s.onload  = resolve
      s.onerror = () => reject(new Error(`Failed to load: ${src}`))
      document.head.appendChild(s)
    })
  }

  async function _ensureMediaPipe() {
    const BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe'
    const scripts = [
      `${BASE}/camera_utils/camera_utils.js`,
      `${BASE}/drawing_utils/drawing_utils.js`,
      `${BASE}/face_mesh/face_mesh.js`
    ]
    for (const src of scripts) await _loadScript(src)

    for (let i = 0; i < 50; i++) {
      if (typeof window.FaceMesh !== 'undefined') return true
      await new Promise(r => setTimeout(r, 100))
    }
    return false
  }

  async function _initFaceMesh() {
    if (typeof window.FaceMesh === 'undefined') {
      console.log('[StudyTwin Blink] Loading MediaPipe dynamically…')
      const loaded = await _ensureMediaPipe()
      if (!loaded) {
        console.warn('[StudyTwin Blink] MediaPipe failed to load')
        _isReady = true
        return false
      }
    }

    _faceMesh = new window.FaceMesh({
      locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/${file}`
    })
    _faceMesh.setOptions({
      maxNumFaces:           1,
      refineLandmarks:       true,
      minDetectionConfidence:0.5,
      minTrackingConfidence: 0.5
    })
    await _faceMesh.initialize()
    _faceMesh.onResults(_onResults)

    // Custom rAF loop (avoids duplicate camera stream from MediaPipe Camera util)
    let _rafBusy = false
    const loop = async () => {
      if (!_rafBusy && _faceMesh && _videoEl && _videoEl.readyState >= 2) {
        _rafBusy = true
        try { await _faceMesh.send({ image: _videoEl }) } catch (e) { /* ignore */ }
        _rafBusy = false
      }
      if (_videoEl && typeof _videoEl.requestVideoFrameCallback === 'function') {
        _videoEl.requestVideoFrameCallback(loop)
      } else {
        requestAnimationFrame(loop)
      }
    }

    if (_videoEl && typeof _videoEl.requestVideoFrameCallback === 'function') {
      _videoEl.requestVideoFrameCallback(loop)
    } else {
      requestAnimationFrame(loop)
    }
    return true
  }

  // ── Public API ──
  async function start() {
    console.log('[StudyTwin Blink] Starting…')
    const cameraOk = await _requestCamera()
    if (!cameraOk) {
      console.log('[StudyTwin Blink] No camera – using default blink score (50)')
      return false
    }
    await new Promise(r => setTimeout(r, 500))
    const meshOk = await _initFaceMesh()
    if (!meshOk) return false
    _broadcast()
    console.log('[StudyTwin Blink] Ready ✓')
    return true
  }

  function startCalibration() {
    _calibEARs    = []
    _calibFrames  = 0
    _isReady      = false
    _isCalibrating= true
    console.log('[StudyTwin Blink] EAR calibration started')
    _updateCalibUI(0)
  }

  function subscribe(fn) {
    _subscribers.push(fn)
    fn({ blinkRate: _currentRate, blinkScore: _currentScore, ear: _currentEAR, faceDetected: _faceDetected, isReady: _isReady })
    return () => { _subscribers = _subscribers.filter(s => s !== fn) }
  }

  const getScore      = () => _currentScore
  const getRate       = () => _currentRate
  const ready         = () => _isReady
  const hasCam        = () => _cameraGranted
  const isFaceTracked = () => _faceDetected

  return { start, startCalibration, subscribe, getScore, getRate, ready, hasCam, isFaceTracked, acceptVideo }

})()

window.BlinkDetector = BlinkDetector
console.log('[StudyTwin] blink-detection.js loaded ✓  (Phase 2 – writes to live/current)')