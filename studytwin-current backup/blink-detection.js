/* ══════════════════════════════════════════════════════════════
   STUDYTWIN — MediaPipe Blink Detection Module
   1:1 parity with blink_server.py (Python) for identical accuracy
   Pixel-space EAR · EMA smoothing · 300ms cooldown · 3-frame gate
══════════════════════════════════════════════════════════════ */

const BlinkDetector = (() => {

  // ── Eye landmark indices — IDENTICAL to Python blink_server.py ──
  // Python: RIGHT_EYE_EAR = [33, 159, 158, 133, 153, 145]
  // Python: LEFT_EYE_EAR  = [362, 380, 374, 263, 386, 385]
  // Order: [p1, p2, p3, p4, p5, p6]
  // EAR = (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)
  const LEFT_EYE  = [362, 380, 374, 263, 386, 385]
  const RIGHT_EYE = [33,  159, 158, 133, 153, 145]

  // ── State ──
  let _isReady = false
  let _isCalibrating = false
  let _calibFrames = 0
  let _calibEARs = []
  let _earThreshold = 0.285       // Python: EAR_THRESHOLD_DEFAULT = 0.285
  let _earBaseline = 0.30
  let _consecLow = 0
  let _totalBlinks = 0
  let _countStartTime = 0
  let _currentRate = 0
  let _currentScore = 50
  let _currentEAR = 0
  let _smoothedEAR = -1           // EMA state (-1 = uninitialized)
  let _lastBlinkTime = 0          // cooldown timestamp
  let _faceDetected = false
  let _cameraGranted = false
  let _faceMesh = null
  let _camera = null
  let _videoEl = null
  let _externalVideo = false   // true when using a video element provided by the page
  let _subscribers = []
  let _lastFBWrite = 0
  let _frameCount = 0
  let _resultCount = 0

  // ── PIXEL-SPACE EAR — exact clone of Python compute_ear() ──
  // Python: pts = [[lm[i].x * img_w, lm[i].y * img_h] for i in indices]
  // We must scale normalized (0-1) landmarks to pixel coordinates
  // because EAR is aspect-ratio sensitive: a 640x480 video gives
  // different normalized-space EAR than pixel-space EAR by factor H/W.
  function computeEAR(lm, eyeIndices, w, h) {
    const px = (idx) => [lm[idx].x * w, lm[idx].y * h]
    const p1 = px(eyeIndices[0]), p2 = px(eyeIndices[1])
    const p3 = px(eyeIndices[2]), p4 = px(eyeIndices[3])
    const p5 = px(eyeIndices[4]), p6 = px(eyeIndices[5])

    const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)
    const A = dist(p2, p6)   // ||p2-p6||  vertical
    const B = dist(p3, p5)   // ||p3-p5||  vertical
    const C = dist(p1, p4)   // ||p1-p4||  horizontal

    return C < 1e-6 ? 0.30 : (A + B) / (2.0 * C)
  }

  // ── Score formula — matches Python blink_rate_to_score() ──
  function rateToScore(bpm) {
    if (bpm <= 0) return 0
    return Math.max(0, Math.min(100, Math.round(100 - Math.abs(bpm - 15) * 8)))
  }

  function _onResults(results) {
    _resultCount++

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

    // Get video dimensions for pixel-space scaling
    const w = (_videoEl && _videoEl.videoWidth)  || 640
    const h = (_videoEl && _videoEl.videoHeight) || 480

    // Compute EAR in pixel space — identical to Python
    const leftEAR  = computeEAR(lm, LEFT_EYE, w, h)
    const rightEAR = computeEAR(lm, RIGHT_EYE, w, h)
    const rawEAR   = (leftEAR + rightEAR) / 2.0

    // Apply Exponential Moving Average for noise suppression
    // α = 0.4 gives fast response (reacts in 2-3 frames) while killing jitter
    const EMA_ALPHA = 0.4
    if (_smoothedEAR < 0) _smoothedEAR = rawEAR   // initialize on first frame
    _smoothedEAR = _smoothedEAR * (1 - EMA_ALPHA) + rawEAR * EMA_ALPHA
    _currentEAR = _smoothedEAR

    // ── CALIBRATION PHASE ──
    if (_isCalibrating) {
      // Collect RAW (unsmoothed) EAR for clean baseline calculation
      _calibEARs.push(rawEAR)
      _calibFrames++
      const pct = Math.min(100, Math.round((_calibFrames / 180) * 100))
      _updateCalibUI(pct)

      if (_calibFrames >= 180) {
        // Match Python exactly: 60th percentile as baseline
        _calibEARs.sort((a, b) => a - b)
        _earBaseline = _calibEARs[Math.floor(_calibEARs.length * 0.6)]

        // Match Python: threshold = max(0.18, min(0.35, baseline * 0.75))
        _earThreshold = Math.max(0.18, Math.min(0.35, _earBaseline * 0.75))

        _isCalibrating = false
        _isReady = true
        _countStartTime = Date.now()
        _smoothedEAR = _earBaseline  // reset smoother to baseline

        console.log(`[StudyTwin Blink] Calibrated ✓  baseline=${_earBaseline.toFixed(4)}  threshold=${_earThreshold.toFixed(4)}  video=${w}x${h}`)

        _updateCalibUI(100)
        const mean = _calibEARs.reduce((a, b) => a + b, 0) / _calibEARs.length
        document.dispatchEvent(new CustomEvent('blinkCalibrationComplete', {
          detail: { threshold: _earThreshold, mean, std: 0 }
        }))
      }
      // Always broadcast during calibration so UI updates
      _broadcast()
      return
    }

    if (!_isReady) return

    // ── BLINK DETECTION — matches Python exactly ──
    const now = Date.now()

    if (_smoothedEAR < _earThreshold) {
      _consecLow++
    } else {
      // Python: if frame_ctr >= CONSEC_FRAMES (3): count blink
      // Added: 300ms cooldown (humans blink 15-20x/min ≈ one every 3-4 seconds)
      if (_consecLow >= 3 && (now - _lastBlinkTime) > 300) {
        _totalBlinks++
        _lastBlinkTime = now
        document.dispatchEvent(new CustomEvent('blinkDetected', { detail: { ear: _smoothedEAR } }))
      }
      _consecLow = 0
    }

    // ── RATE CALCULATION — matches Python ──
    // Python: blink_rate = round(state['blink_count'] / elapsed_minutes, 1)
    const elapsedMinutes = Math.max((now - _countStartTime) / 60000, 1 / 60)
    _currentRate = Math.round((_totalBlinks / elapsedMinutes) * 10) / 10
    _currentScore = rateToScore(_currentRate)

    _broadcast()
    _writeToFirebase()
  }

  function _broadcast() {
    const payload = {
      blinkRate: _currentRate,
      blinkScore: _currentScore,
      ear: _currentEAR,
      faceDetected: _faceDetected,
      isReady: _isReady,
      cameraGranted: _cameraGranted,
      earThreshold: _earThreshold
    }
    _subscribers.forEach(fn => fn(payload))

    document.dispatchEvent(new CustomEvent('blinkUpdate', { detail: payload }))
  }

  // _updateDashboardUI removed — dashboard listens to 'blinkUpdate' CustomEvent

  // _updateStatusUI removed — status is conveyed via 'blinkUpdate' CustomEvent payload

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

  function _writeToFirebase() {
    const now = Date.now()
    if (now - _lastFBWrite < 5000) return
    if (!window.firebase?.database || !window.CURRENT_UID) return
    _lastFBWrite = now

    try {
      const ref = window.firebase.database().ref(`/sessions/${window.CURRENT_UID}/live`)
      ref.update({
        blink_score: _currentScore,
        blink_rate: _currentRate,
        blink_ear: parseFloat(_currentEAR.toFixed(4))
      })
    } catch (e) { /* silent */ }
  }

  // ── Accept an external video element (avoids dual camera streams) ──
  // Call this BEFORE start() to reuse an existing playing <video>
  function acceptVideo(videoElement) {
    if (!videoElement || !(videoElement instanceof HTMLVideoElement)) {
      console.warn('[StudyTwin Blink] acceptVideo: invalid element')
      return false
    }
    _videoEl = videoElement
    _externalVideo = true
    _cameraGranted = true
    console.log('[StudyTwin Blink] Using external video element:', videoElement.id || '(no id)')
    return true
  }

  // ── THE KEY FIX: Camera request without facingMode ──────────
  // facingMode:'user' BREAKS OBS Virtual Camera and DroidCam.
  // Virtual cameras have no facing mode — browser rejects them.
  async function _requestCamera() {
    // If an external video was already provided, skip camera acquisition
    if (_externalVideo && _videoEl) {
      _cameraGranted = true
      console.log('[StudyTwin Blink] Skipping camera request — using external video')
      return true
    }

    try {
      // Step 1: enumerate all video devices (works even before permission)
      let preferredDeviceId = null
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const videoDevices = devices.filter(d => d.kind === 'videoinput')
        console.log('[StudyTwin Blink] Found cameras:', videoDevices.map(d => d.label || d.deviceId))

        // Prefer OBS/DroidCam/virtual cameras if present
        const virtual = videoDevices.find(d =>
          /obs|droid|virtual|cam link|elgato|snap|mmhmm|manycam|iriun|epoc|xsplit/i.test(d.label)
        )
        if (virtual && virtual.deviceId) {
          preferredDeviceId = virtual.deviceId
          console.log('[StudyTwin Blink] Found virtual camera:', virtual.label)
        } else if (videoDevices.length > 0 && videoDevices[0].deviceId) {
          preferredDeviceId = videoDevices[0].deviceId
        }
      } catch (enumErr) {
        console.warn('[StudyTwin Blink] Device enumeration failed:', enumErr.message)
      }

      // Step 2: Try constraints in order — NEVER use facingMode with virtual cameras
      const constraintsList = []

      if (preferredDeviceId) {
        // Best: exact device with relaxed resolution
        constraintsList.push({
          video: {
            deviceId: { exact: preferredDeviceId },
            width: { ideal: 640 },
            height: { ideal: 480 }
          }
        })
        // Fallback: exact device, no resolution
        constraintsList.push({ video: { deviceId: { exact: preferredDeviceId } } })
      }

      // Generic fallbacks — NO facingMode
      constraintsList.push({ video: { width: { ideal: 640 }, height: { ideal: 480 } } })
      constraintsList.push({ video: true })

      let stream = null
      let lastError = null

      for (const constraints of constraintsList) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints)
          console.log('[StudyTwin Blink] Camera obtained with:', JSON.stringify(constraints))
          break
        } catch (err) {
          lastError = err
          console.warn('[StudyTwin Blink] Attempt failed:', err.name, '-', err.message)
          // If denied by user, stop trying immediately
          if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') break
        }
      }

      if (!stream) {
        throw lastError || new Error('All camera access attempts failed')
      }

      // Step 3: Create video element for MediaPipe processing
      // CRITICAL FIX: Modern browsers (2025+) throttle video decoding for
      // elements that are offscreen, zero-sized, or fully transparent.
      // We keep it inside the viewport at a real size but visually invisible.
      _videoEl = document.createElement('video')
      _videoEl.id = 'st-mediapipe-video'
      _videoEl.setAttribute('width', '640')
      _videoEl.setAttribute('height', '480')
      _videoEl.style.cssText = [
        'position:fixed', 'top:0', 'left:0',
        'width:1px', 'height:1px',
        'opacity:0.01',            // NOT 0 — browsers skip rendering at 0
        'pointer-events:none',
        'z-index:-9999',
        'clip:rect(0,1px,1px,0)',  // visually clips to 1px but element is "visible"
        'overflow:hidden'
      ].join(';')
      _videoEl.autoplay = true
      _videoEl.muted = true
      _videoEl.playsInline = true
      _videoEl.srcObject = stream
      document.body.appendChild(_videoEl)

      // Ensure video actually starts playing
      try { await _videoEl.play() } catch (e) { /* autoplay handles it */ }

      _cameraGranted = true
      console.log('[StudyTwin Blink] Camera access granted ✓')

      return true
    } catch (err) {
      _cameraGranted = false
      _isReady = true  // use default blink score
      console.warn('[StudyTwin Blink] Camera denied:', err.name, err.message)
      _broadcast()
      return false
    }
  }

  // ── FIXED: Dynamically loads MediaPipe scripts if not already present ──
  function _loadScript(src) {
    return new Promise((resolve, reject) => {
      // If already loaded, resolve immediately
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve()
        return
      }
      const s = document.createElement('script')
      s.src = src
      s.crossOrigin = 'anonymous'
      s.onload = resolve
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

    for (const src of scripts) {
      await _loadScript(src)
    }

    // Wait up to 5s for FaceMesh to appear on window
    for (let i = 0; i < 50; i++) {
      if (typeof window.FaceMesh !== 'undefined') return true
      await new Promise(r => setTimeout(r, 100))
    }

    return false
  }

  async function _initFaceMesh() {
    // Dynamically load MediaPipe if not already on the page
    if (typeof window.FaceMesh === 'undefined') {
      console.log('[StudyTwin Blink] FaceMesh not found — loading MediaPipe dynamically…')
      const loaded = await _ensureMediaPipe()
      if (!loaded) {
        console.warn('[StudyTwin Blink] MediaPipe failed to load after dynamic inject')
        _isReady = true
        return false
      }
      console.log('[StudyTwin Blink] MediaPipe loaded dynamically ✓')
    }

    _faceMesh = new window.FaceMesh({
      locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/${file}`
    })

    _faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    })

    await _faceMesh.initialize()

    _faceMesh.onResults(_onResults)

    // DO NOT use window.Camera here! 
    // MediaPipe's window.Camera utility calls getUserMedia() under the hood,
    // which would open a SECOND competing stream and break DroidCam.
    // Instead, we use a requestAnimationFrame loop to continuously send frames
    // from our already-active _videoEl to FaceMesh.
    
    console.log('[StudyTwin Blink] Using custom frame loop (bypassing MediaPipe Camera utility to prevent dual-streams)')
    let _rafBusy = false
    const loop = async () => {
      // Modern browsers have requestVideoFrameCallback, fallback to rAF
      if (!_rafBusy && _faceMesh && _videoEl && _videoEl.readyState >= 2) {
        _rafBusy = true
        _frameCount++
        
        if (_frameCount % 100 === 1) {
          // Log less frequently, but confirm frames are flowing
          console.log(`[StudyTwin Blink] Frame processing #${_frameCount} (video size: ${_videoEl.videoWidth}x${_videoEl.videoHeight})`)
        }
        
        try {
          // Await ensures we don't pile up frames faster than they can process
          await _faceMesh.send({ image: _videoEl })
        } catch (e) {
          console.warn('[StudyTwin Blink] send() error:', e.message)
        }
        _rafBusy = false
      }
      
      // Keep the loop going
      if (_videoEl && typeof _videoEl.requestVideoFrameCallback === 'function') {
        _videoEl.requestVideoFrameCallback(loop)
      } else {
        requestAnimationFrame(loop)
      }
    }
    
    // Start the loop
    if (_videoEl && typeof _videoEl.requestVideoFrameCallback === 'function') {
        _videoEl.requestVideoFrameCallback(loop)
    } else {
        requestAnimationFrame(loop)
    }

    return true
  }

  async function start() {
    console.log('[StudyTwin Blink] Starting…')

    const cameraOk = await _requestCamera()
    if (!cameraOk) {
      console.log('[StudyTwin Blink] No camera — using default blink score (50)')
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
    _calibEARs = []
    _calibFrames = 0
    _isReady = false
    _isCalibrating = true
    console.log('[StudyTwin Blink] EAR calibration started')
    _updateCalibUI(0)
  }

  function subscribe(fn) {
    _subscribers.push(fn)
    fn({
      blinkRate: _currentRate,
      blinkScore: _currentScore,
      ear: _currentEAR,
      faceDetected: _faceDetected,
      isReady: _isReady
    })
    return () => { _subscribers = _subscribers.filter(s => s !== fn) }
  }

  const getScore = () => _currentScore
  const getRate = () => _currentRate
  const ready = () => _isReady
  const hasCam = () => _cameraGranted
  const isFaceTracked = () => _faceDetected

  return { start, startCalibration, subscribe, getScore, getRate, ready, hasCam, isFaceTracked, acceptVideo }

})()

window.BlinkDetector = BlinkDetector
console.log('[StudyTwin] blink-detection.js loaded ✓')

// Force-broadcast removed — _broadcast() already dispatches 'blinkUpdate' on every frame