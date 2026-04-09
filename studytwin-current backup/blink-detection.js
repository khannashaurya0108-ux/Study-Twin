/* ══════════════════════════════════════════════════════════════
   STUDYTWIN — MediaPipe Blink Detection Module
   FIXED: Works with OBS Virtual Camera, DroidCam, and real webcams
   Root cause of old bug: facingMode:'user' breaks virtual cameras
══════════════════════════════════════════════════════════════ */

const BlinkDetector = (() => {

  const LEFT_EYE = { p1: 33, p2: 160, p3: 158, p4: 133, p5: 153, p6: 144 }
  const RIGHT_EYE = { p1: 362, p2: 385, p3: 387, p4: 263, p5: 373, p6: 380 }

  let _isReady = false
  let _isCalibrating = false
  let _calibFrames = 0
  let _calibEARs = []
  let _earThreshold = 0.23
  let _consecLow = 0
  let _blinkTimes = []
  let _currentRate = 0
  let _currentScore = 50
  let _currentEAR = 0
  let _faceDetected = false
  let _cameraGranted = false
  let _faceMesh = null
  let _camera = null
  let _videoEl = null
  let _subscribers = []
  let _lastFBWrite = 0

  const dist3d = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)

  function computeEAR(lm, eye) {
    const d26 = dist3d(lm[eye.p2], lm[eye.p6])
    const d35 = dist3d(lm[eye.p3], lm[eye.p5])
    const d14 = dist3d(lm[eye.p1], lm[eye.p4])
    if (d14 < 0.0001) return 0.25
    return (d26 + d35) / (2 * d14)
  }

  function rateToScore(rate) {
    return Math.max(0, Math.min(100, 8 * (12 - rate)))
  }

  function _onResults(results) {
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

    const leftEAR = computeEAR(lm, LEFT_EYE)
    const rightEAR = computeEAR(lm, RIGHT_EYE)
    const avgEAR = (leftEAR + rightEAR) / 2
    _currentEAR = avgEAR

    if (_isCalibrating) {
      _calibEARs.push(avgEAR)
      _calibFrames++
      const pct = Math.min(100, Math.round((_calibFrames / 180) * 100))
      _updateCalibUI(pct)

      if (_calibFrames >= 180) {
        const mean = _calibEARs.reduce((a, b) => a + b, 0) / _calibEARs.length
        const variance = _calibEARs.reduce((a, b) => a + (b - mean) ** 2, 0) / _calibEARs.length
        const std = Math.sqrt(variance)
        _earThreshold = Math.max(0.12, mean - 0.3 * std)
        _isCalibrating = false
        _isReady = true
        console.log(`[StudyTwin Blink] EAR calibrated ✓ threshold=${_earThreshold.toFixed(4)}`)
        _updateCalibUI(100)
        document.dispatchEvent(new CustomEvent('blinkCalibrationComplete', {
          detail: { threshold: _earThreshold, mean, std }
        }))
      }
      return
    }

    if (!_isReady) return

    if (avgEAR < _earThreshold) {
      _consecLow++
    } else {
      if (_consecLow >= 2) {
        _blinkTimes.push(Date.now())
        document.dispatchEvent(new CustomEvent('blinkDetected', { detail: { ear: avgEAR } }))
      }
      _consecLow = 0
    }

    const now = Date.now()
    _blinkTimes = _blinkTimes.filter(t => now - t < 60000)

    _currentRate = _blinkTimes.length
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

  // ── THE KEY FIX: Camera request without facingMode ──────────
  // facingMode:'user' BREAKS OBS Virtual Camera and DroidCam.
  // Virtual cameras have no facing mode — browser rejects them.
  async function _requestCamera() {
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

      // Step 3: Create hidden video element
      _videoEl = document.createElement('video')
      _videoEl.id = 'st-mediapipe-video'
      _videoEl.style.cssText = [
        'position:fixed', 'top:-9999px', 'left:-9999px',
        'width:1px', 'height:1px', 'opacity:0.001',
        'pointer-events:none', 'z-index:-1'
      ].join(';')
      _videoEl.autoplay = true
      _videoEl.muted = true
      _videoEl.playsInline = true
      _videoEl.srcObject = stream
      document.body.appendChild(_videoEl)

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

  return { start, startCalibration, subscribe, getScore, getRate, ready, hasCam, isFaceTracked }

})()

window.BlinkDetector = BlinkDetector
console.log('[StudyTwin] blink-detection.js loaded ✓')

// Force-broadcast removed — _broadcast() already dispatches 'blinkUpdate' on every frame