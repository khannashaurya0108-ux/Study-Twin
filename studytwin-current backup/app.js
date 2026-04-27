/* ══════════════════════════════════════════════════════════════
   STUDYTWIN — Core Application Engine  (Antigravity Luxe)
   IEEE Paper §V Data Engine · Nav/Footer · Scroll Reveal
   Neural Constellation Brain (Three.js)
══════════════════════════════════════════════════════════════ */

// ── 1. DATA ENGINE (IEEE §V) ────────────────────────────────
// Weighted fusion: CLI = (GSR × 0.50) + (HRV × 0.35) + (Blink × 0.15)
// EMA α = 0.28, mirrors ESP32 firmware
// UI is NEVER blank — hardcoded initial data from the paper.



const SERVER_URL = 'https://study-twin.onrender.com'; // your Render URL
// For local testing use: 'http://localhost:3001' 

const ST_Engine = {
  cbs: [],
  add(fn) { this.cbs.push(fn) },
  start() {
    const tick = (time) => {
      this.cbs.forEach(cb => cb(time))
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
}
ST_Engine.start()

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBXZZ-wN2wzguf35rfPaLqm61gx0LoxIAA",
  authDomain: "studytwin-rvce.firebaseapp.com",
  databaseURL: "https://studytwin-rvce-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "studytwin-rvce",
  storageBucket: "studytwin-rvce.firebasestorage.app",
  messagingSenderId: "345837599600",
  appId: "1:345837599600:web:f2c191ab3cf7c24ca5edb5"
}

const DATA_SOURCE = 'firebase'

/*
  Firebase Realtime Database Schema
  
  /sessions/{session_id}/live       ← ESP32 overwrites every 1000ms
    ts: Unix timestamp
    gsr_raw: 0-4095 ADC count
    gsr_z: z-score deviation from baseline
    rmssd: HRV RMSSD in milliseconds
    cli_score: 0-100 fused Cognitive Load Index
    cli_state: "calm" | "focused" | "elevated" | "overloaded"
    battery: millivolts (3400-4180)
    
  /sessions/{session_id}/metadata   ← Written once at session start
    student_id: string
    start_time: Unix timestamp
    cds_executive: 0-100
    cds_language: 0-100
    cds_visual: 0-100
    material: string
    
  /sessions/{session_id}/history    ← ESP32 appends every 1000ms
    {firebase_push_id}: { same fields as /live }
*/

let ST_prevCLI = null;

function getBlinkScore() {
  const score = window.BLINK_SCORE;
  if (typeof score === "number" && !isNaN(score)) {
    return Math.max(0, Math.min(100, score));
  }
  return 50;
}

function computeCLI(gsr_score, hrv_score) {
  const blink_score = getBlinkScore();
  const raw_cli = (gsr_score * 0.50) + (hrv_score * 0.35) + (blink_score * 0.15);
  const alpha = 0.28;
  const prev = (typeof ST_prevCLI === "number") ? ST_prevCLI : raw_cli;
  const smoothed = prev * (1 - alpha) + raw_cli * alpha;
  ST_prevCLI = smoothed;
  return Math.round(smoothed);
}

function classifyState(cli) {
  if (cli < 26) return "calm";
  if (cli < 56) return "focused";
  if (cli < 78) return "elevated";
  return "overloaded";
}

function mapGSRtoScore(gsr_z) {
  const gsrDev = gsr_z * 100;
  return Math.min(100, Math.max(0, (gsrDev / 82) * 100));
}

function mapHRVtoScore(rmssd) {
  return Math.max(0, Math.min(100, 100 - ((rmssd - 18) / 70) * 100));
}

function connectFirebase() {
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
    if (!window.firebase.apps.length) {
      window.firebase.initializeApp(FIREBASE_CONFIG);
    }

    const auth = window.firebase.auth();
    auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL);
    const db = window.firebase.database();

    // Google Sign-In function — called by the button in dashboard.html
    window.signInWithGoogle = function () {
      const provider = new window.firebase.auth.GoogleAuthProvider();
      auth.signInWithPopup(provider).catch(err => {
        const errEl = document.getElementById('auth-error');
        if (errEl) { errEl.textContent = 'Sign-in failed. Try again.'; errEl.style.display = 'block'; }
      });
    };

    auth.onAuthStateChanged(user => {
      const overlay = document.getElementById('auth-overlay');

      if (user) {
        // Confirmed logged in — hide overlay if it was shown
        if (overlay) overlay.style.display = 'none';
        window.CURRENT_UID = user.uid;

        db.ref('/sessions/' + user.uid + '/metadata').once('value', (snap) => {
          const meta = snap.val();
          if (meta && (meta.cds_executive > 0 || meta.cds_language > 0 || meta.cds_visual > 0)) {
            TRIBE.updateFromFirebase(meta);
          }
        });

        db.ref('/sessions/' + user.uid + '/metadata').on('value', (snap) => {
          const meta = snap.val();
          if (meta && meta.tribe_mode && meta.tribe_mode !== 'default' &&
              (meta.cds_executive > 0 || meta.cds_language > 0 || meta.cds_visual > 0)) {
            TRIBE.updateFromFirebase(meta);
          }
        });

        db.ref('/sessions/' + user.uid + '/live').on('value', (snapshot) => {
          const data = snapshot.val();
          if (data && ST._subs) {
            const gsr_score = data.gsr_z !== undefined ? mapGSRtoScore(data.gsr_z) : 50;
            const hrv_score = data.rmssd !== undefined ? mapHRVtoScore(data.rmssd) : 50;

            const cli = computeCLI(gsr_score, hrv_score);
            const state = classifyState(cli);

            ST._subs.forEach(fn => fn({
              ...ST.get(),
              gsrRaw: data.gsr_raw,
              gsrDev: data.gsr_z !== undefined ? data.gsr_z * 100 : 0,
              hrv: data.rmssd,
              cli: cli,
              state: state,
              battery: data.battery
            }));
          }
        });

      } else {
        // Confirmed NOT logged in — only now show the overlay
        if (overlay) overlay.style.display = 'flex';
      }
    });

  }).catch(err => {
    console.warn('Failed to load Firebase SDK, falling back to simulation:', err);
    if (ST.tick) setInterval(ST.tick, 2000);
  });
}

const ST = (() => {
  const ALPHA = 0.28
  const _t0 = Date.now()

  let _d = {
    cli: 42, state: 'focused',
    hr: 68, hrv: 52.4, spo2: 98,
    gsrRaw: 2280, gsrDev: 14.2, blink: 13.8,
    battery: 3860, sessionS: 0,
    accuracy: '83.4%', latency: '47ms'
  }
  let _subs = []

  const wander = (v, lo, hi, s) => Math.max(lo, Math.min(hi, v + (Math.random() - .5) * s * 2))
  const stateOf = c => c < 26 ? 'calm' : c < 56 ? 'focused' : c < 78 ? 'elevated' : 'overloaded'

  function tick() {
    const gsr = wander(_d.gsrDev, 0, 82, 3.0)
    const hrv = wander(_d.hrv, 18, 88, 3.6)
    const bl = wander(_d.blink, 4, 24, 1.3)
    const hr = Math.round(wander(_d.hr, 54, 102, 1.7))
    const gsrS = Math.min(100, (gsr / 82) * 100)
    const hrvS = Math.max(0, 100 - ((hrv - 18) / 70) * 100)
    const blS = bl < 10 ? 82 : Math.max(0, 100 - (bl / 24) * 62)
    // Also use real blink rate if available
    const blinkRateReal = (typeof window.BLINK_RATE === 'number')
                        ? window.BLINK_RATE
                        : Math.round(bl * 10) / 10;

    const cli = computeCLI(gsrS, hrvS);
    _d = {
      cli, state: classifyState(cli), hr,
      hrv: Math.round(hrv * 10) / 10,
      spo2: Math.round(wander(_d.spo2, 95, 100, .2) * 10) / 10,
      gsrRaw: Math.round(1800 + gsr * 14),
      gsrDev: Math.round(gsr * 10) / 10,
      blink: blinkRateReal,
      battery: Math.round(wander(_d.battery, 3400, 4180, 3)),
      sessionS: Math.floor((Date.now() - _t0) / 1000),
      accuracy: '83.4%', latency: '47ms'
    }
    _subs.forEach(fn => fn({ ..._d }))
  }

  // Tick every 2 seconds
  if (DATA_SOURCE === 'simulation') {
    setInterval(tick, 2000)
  } else if (DATA_SOURCE === 'firebase') {
    connectFirebase()
  }

  return {
    get _subs() { return _subs; },
    get tick() { return tick; },
    subscribe(fn) {
      _subs.push(fn)
      fn({ ..._d }) // CRITICAL: immediate DOM population, no "--" ever
      return () => { _subs = _subs.filter(s => s !== fn) }
    },
    get() { return { ..._d } },
    color(c) { if (c === undefined) c = _d.cli; return c < 26 ? '#059669' : c < 56 ? '#2563EB' : c < 78 ? '#D97706' : '#DC2626' },
    stateColor(s) { return { calm: '#059669', focused: '#2563EB', elevated: '#D97706', overloaded: '#DC2626' }[s || _d.state] || '#2563EB' },
    label(s) { return { calm: 'Calm', focused: 'Focused', elevated: 'Elevated', overloaded: 'Overloaded' }[s || _d.state] || 'Focused' },
    fmtTime(s) { return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
  }
})()

// ── CURRENT UID (Phase 5: Blink Detection + TRIBE) ────────────
window.CURRENT_UID = null;  // set by connectFirebase() after login

// ── NAV + FOOTER ────────────────────────────────────────────
const NAV_LINKS = [
  { href: 'index.html', label: 'Home' },
  { href: 'dashboard.html', label: 'Dashboard' },
  { href: 'brain-map.html', label: 'Brain Intelligence' },
  { href: 'blink.html', label: 'Blink Rate' },
  { href: 'how-it-works.html', label: 'How It Works' },
  { href: 'get-started.html', label: 'Get Started' },
]

function renderNav(activePage) {
  const el = document.getElementById('_nav')
  if (!el) return
  el.innerHTML = `
  <nav>
    <a class="nav-logo" href="index.html">
      <div class="nav-logo-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="4"/>
          <line x1="12" y1="2" x2="12" y2="6"/>
          <line x1="12" y1="18" x2="12" y2="22"/>
          <line x1="2" y1="12" x2="6" y2="12"/>
          <line x1="18" y1="12" x2="22" y2="12"/>
        </svg>
      </div>
      <span class="nav-wordmark">Study<em>Twin</em></span>
    </a>
    <ul class="nav-links">
      ${NAV_LINKS.map(l => `<li><a href="${l.href}"${l.href === activePage ? ' class="active"' : ''}>${l.label}</a></li>`).join('')}
    </ul>
    <div class="nav-right">
      <div class="live-pill"><div class="pulse"></div>LIVE</div>
      <a href="dashboard.html" class="btn-primary" style="font-size:13px;padding:9px 20px;">Open Dashboard</a>
    </div>
  </nav>`
}

function renderFooter() {
  const el = document.getElementById('_footer')
  if (!el) return
  el.innerHTML = `
  <footer>
    <div>
      <div class="footer-brand">Study<em>Twin</em></div>
      <div class="footer-copy">Know your mind. Study smarter.</div>
    </div>
    <nav class="footer-links">
      ${NAV_LINKS.map(l => `<a href="${l.href}">${l.label}</a>`).join('')}
    </nav>
  </footer>`
}

// ── SCROLL REVEAL ────────────────────────────────────────────
function initScrollReveal() {
  const els = document.querySelectorAll('[data-reveal],[data-reveal-x]')
  const delays = ['0ms', '80ms', '160ms', '240ms', '320ms', '400ms']
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.style.transitionDelay = e.target.dataset.delay || '0ms'
        e.target.classList.add('revealed')
        io.unobserve(e.target)
      }
    })
  }, { rootMargin: '-60px', threshold: 0.05 })
  els.forEach(el => io.observe(el))
  document.querySelectorAll('[data-reveal-group]').forEach(parent => {
    Array.from(parent.querySelectorAll('[data-reveal],[data-reveal-x]')).forEach((el, i) => {
      el.style.transitionDelay = delays[i] || '0ms'
    })
  })
}

// ── SPRING PHYSICS ──────────────────────────────────────────
class Spring {
  constructor(val, stiff = 160, damp = 26) {
    this.val = val; this.target = val; this.vel = 0
    this.stiff = stiff; this.damp = damp; this._raf = null; this._cbs = []
  }
  set(v) { this.target = v; this._run() }
  onChange(fn) { this._cbs.push(fn); return () => { this._cbs = this._cbs.filter(f => f !== fn) } }
  _run() {
    if (this._raf) return
    const step = () => {
      const f = -this.stiff * (this.val - this.target) - this.damp * this.vel
      this.vel += f * .016; this.val += this.vel * .016
      this._cbs.forEach(fn => fn(this.val))
      if (Math.abs(this.val - this.target) < .01 && Math.abs(this.vel) < .01) {
        this.val = this.target; this._cbs.forEach(fn => fn(this.val)); this._raf = null
      } else this._raf = requestAnimationFrame(step)
    }
    this._raf = requestAnimationFrame(step)
  }
}

// ── 2. DYNAMIC THREE.JS LOADER ──────────────────────────────
const loadThree = () => new Promise((resolve, reject) => {
  if (window.THREE) return resolve(window.THREE)
  const s = document.createElement('script')
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'
  s.onload = () => resolve(window.THREE)
  s.onerror = () => reject(new Error('Three.js failed to load'))
  document.head.appendChild(s)
})

// ── 3. HIGH-FIDELITY ANATOMICAL NEURAL TWIN ─────────────────
// Stable 1,500 point Dual-Ellipsoid math model, Cerebral Fissure,
// Cortex Curvature (sin/cos noise), Core Glow, Golden-Amber
// Pulse Spike with Jitter, Parallax, and Antigravity float.
function initAntigravityBrain(THREE, canvas) {
  if (!THREE || !canvas) return null

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / canvas.clientHeight, 0.1, 1000)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))

  // STABILITY FIX
  camera.position.z = 10

  // ── CORE GLOW (PointLight) ──
  const coreLight = new THREE.PointLight(0x2563EB, 3, 10)
  coreLight.position.set(0, 0, 0)
  scene.add(coreLight)

  // ── LIQUID SPARK TEXTURE ──
  const canvasSpark = document.createElement('canvas')
  canvasSpark.width = 64; canvasSpark.height = 64
  const ctx = canvasSpark.getContext('2d')
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.2, 'rgba(255,255,255,0.8)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 64, 64)
  const sparkGeoTexture = new THREE.CanvasTexture(canvasSpark)

  // ── THE UNBREAKABLE GEOMETRY (Dual-Ellipsoid) ──
  const N = 1500
  const nodePositions = new Float32Array(N * 3)
  const nodeVecs = []

  function generateBrainPoint(side) {
    const a = 1.0, b = 0.8, c = 1.05
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)

    // The Folds (Sulci) via Sinewave displacement
    let r = 1.8
    r += Math.sin(phi * 10) * Math.cos(theta * 10) * 0.15

    let x = r * Math.sin(phi) * Math.cos(theta) * a
    let y = r * Math.cos(phi) * b
    let z = r * Math.sin(phi) * Math.sin(theta) * c

    // Two Hemispheres: enforce x > 0.1 or x < -0.1
    x = side * (Math.abs(x) + 0.1)

    return { x, y, z }
  }

  for (let i = 0; i < N; i++) {
    // Distribute left and right evenly
    const side = i % 2 === 0 ? 1 : -1
    const pt = generateBrainPoint(side)
    nodePositions[i * 3] = pt.x
    nodePositions[i * 3 + 1] = pt.y
    nodePositions[i * 3 + 2] = pt.z
    nodeVecs.push(pt)
  }

  const nodeGeo = new THREE.BufferGeometry()
  nodeGeo.setAttribute('position', new THREE.BufferAttribute(nodePositions, 3))
  const nodeMat = new THREE.PointsMaterial({
    color: 0x2563EB, size: 0.25, transparent: true, opacity: 0.9,
    sizeAttenuation: true, map: sparkGeoTexture,
    depthWrite: false, blending: THREE.AdditiveBlending
  })

  const brainGroup = new THREE.Group()
  const points = new THREE.Points(nodeGeo, nodeMat)
  brainGroup.add(points)

  // ── SYNAPSES (< 0.4 unit radius) ──
  const SYN_DIST = 0.4
  const linePts = []
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const dx = nodeVecs[i].x - nodeVecs[j].x
      const dy = nodeVecs[i].y - nodeVecs[j].y
      const dz = nodeVecs[i].z - nodeVecs[j].z
      if (dx * dx + dy * dy + dz * dz < SYN_DIST * SYN_DIST) {
        linePts.push(
          nodeVecs[i].x, nodeVecs[i].y, nodeVecs[i].z,
          nodeVecs[j].x, nodeVecs[j].y, nodeVecs[j].z
        )
      }
    }
  }
  const lineGeo = new THREE.BufferGeometry()
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePts), 3))
  const lineMat = new THREE.LineBasicMaterial({
    color: 0x2563EB, transparent: true, opacity: 0.15,
    depthWrite: false, blending: THREE.AdditiveBlending
  })
  const lines = new THREE.LineSegments(lineGeo, lineMat)
  brainGroup.add(lines)

  scene.add(brainGroup)

  // ── MOUSE PARALLAX ──
  let mouseX = 0, mouseY = 0
  document.addEventListener('mousemove', e => {
    mouseX = (e.clientX / window.innerWidth) * 2 - 1
    mouseY = -(e.clientY / window.innerHeight) * 2 - 0.5
  })

  // ── THE DATA SPIKE ──
  let tgtColor = new THREE.Color(0x2563EB)
  let isSpiking = false

  const setColor = hex => { if (!isSpiking) tgtColor.set(hex) }

  function triggerNeuralSpike(cli) {
    if (cli > 70) {
      isSpiking = true
      tgtColor.set('#FBBF24') // Amber
      coreLight.color.set('#FBBF24')
    } else {
      isSpiking = false
      coreLight.color.set(0x2563EB)
    }
  }

  // ── PHYSICS & RENDERING ──
  function animate() {
    const time = Date.now() * 0.001

    points.rotation.y += 0.001
    lines.rotation.y += 0.001

    // Synapse data flow pulse
    lineMat.opacity = 0.15 + (Math.sin(time * 3) * 0.1)

    // Antigravity Float & Jitter Spike
    if (isSpiking) {
      brainGroup.position.x = (Math.random() - 0.5) * 0.02
      brainGroup.position.y = Math.sin(time * 1.5) * 0.15 + (Math.random() - 0.5) * 0.02
      brainGroup.position.z = (Math.random() - 0.5) * 0.02
    } else {
      brainGroup.position.x = 0
      brainGroup.position.y = Math.sin(time * 1.5) * 0.15
      brainGroup.position.z = 0
    }

    // Premium Parallax (25 degrees max ≈ 0.436 rad, 0.05 damping)
    const maxTilt = 0.436
    const tgtRotX = mouseY * maxTilt
    const tgtRotY = mouseX * maxTilt
    scene.rotation.x += (tgtRotX - scene.rotation.x) * 0.05
    scene.rotation.y += (tgtRotY - scene.rotation.y) * 0.05

    // Smooth Color Transition via Lerp
    nodeMat.color.lerp(tgtColor, 0.05)
    lineMat.color.lerp(tgtColor, 0.05)

    renderer.render(scene, camera)
  }

  function resize() {
    if (!renderer || !camera || !canvas) return
    const parent = canvas.parentElement || document.body;
    const w = parent.clientWidth || 300;
    const h = parent.clientHeight || 300;
    renderer.setSize(w, h, false)
    camera.aspect = w / h; camera.updateProjectionMatrix()
  }
  window.addEventListener('resize', resize)
  // Ensure we resize on next tick to capture parent dimensions
  setTimeout(resize, 0);
  ST_Engine.add(animate)

  return { setColor, triggerNeuralSpike }
}

// ── INIT ON LOAD ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page || 'index'
  renderNav(page + '.html')
  renderFooter()
  initScrollReveal()
  document.querySelector('.page')?.classList.add('page-in')

  // ── Phase 3: Start MediaPipe Blink Detection ─────────────────────────────
  // BlinkDetector is defined in blink-detection.js (must be loaded BEFORE app.js)
  if (window.BlinkDetector) {
    // Auto-start on dashboard page only
    if (document.body.dataset.page === 'dashboard') {
      setTimeout(async () => {
        const started = await BlinkDetector.start();
        if (started) {
          console.log('[StudyTwin] BlinkDetector started — camera active');
        } else {
          console.log('[StudyTwin] BlinkDetector fallback — no camera');
        }
      }, 2000);  // 2s delay to let page fully render first
    }
  }

  // 2. Magnetic UI Elements & 4. GSAP ScrollTriggers
  if (typeof gsap !== 'undefined') {
    const magnetics = document.querySelectorAll('.btn-primary, .card')
    magnetics.forEach(el => {
      el.addEventListener('mousemove', e => {
        const rect = el.getBoundingClientRect()
        const x = (e.clientX - rect.left) - rect.width / 2
        const y = (e.clientY - rect.top) - rect.height / 2
        gsap.to(el, { x: (x / (rect.width / 2)) * 15, y: (y / (rect.height / 2)) * 15, duration: 0.3, ease: 'power2.out' })
      })
      el.addEventListener('mouseleave', () => {
        gsap.to(el, { x: 0, y: 0, duration: 1, ease: 'elastic.out(1, 0.3)' })
      })
    })

    gsap.registerPlugin(ScrollTrigger)
    const cards = document.querySelectorAll('.card')
    cards.forEach(card => {
      gsap.fromTo(card,
        { scale: 1.1, rotationX: 10, opacity: 0, transformPerspective: 1000 },
        {
          scale: 1, rotationX: 0, opacity: 1,
          duration: 1.2, ease: 'power3.out',
          scrollTrigger: {
            trigger: card,
            start: 'top 85%',
            toggleActions: 'play none none reverse'
          }
        }
      )
    })
  }
})

// ── 4. TRIBE ENGINE (Cognitive Domain Analysis) ──────────────
const TRIBE = (() => {
  // Default values (used before Kaggle analysis or as fallback)
  let _cds = {
    executive: 82,
    language: 67,
    visual: 34,
    material: 'Advanced Signals & Systems — Lecture 14',
    analysed: true,
    recommended_duration: 0,
    recommended_threshold: 0,
    dominant_region: 'Executive',
    routing_recommendation: '',
    tribe_mode: 'default',    // 'default' | 'lite_nlp' | 'full_v2'
    analysed_at: null
  }

  function computeParams() {
    const exec = _cds.cds_executive || _cds.executive  // handle both key names
    _cds.recommended_duration = Math.round(32 - (exec / 100) * 16)   // 16-32 min
    _cds.recommended_threshold = Math.round(80 - (exec / 100) * 22)   // 58-80
  }
  computeParams()

  function getDominantRegion() {
    const regions = [
      {
        name: 'Executive',
        score: _cds.cds_executive || _cds.executive,
        recommendation: _cds.routing_recommendation ||
          'Switch to visual review material — diagrams, flowcharts, or video summaries. Your prefrontal cortex needs reduced working memory demand.'
      },
      {
        name: 'Language',
        score: _cds.cds_language || _cds.language,
        recommendation: 'Switch to numerical or visual content — equations, graphs, or problem sets. Reduce dense reading.'
      },
      {
        name: 'Visual',
        score: _cds.cds_visual || _cds.visual,
        recommendation: 'Switch to audio or text-light reading. Reduce diagram and animation-heavy material.'
      }
    ]
    return regions.sort((a, b) => b.score - a.score)[0]
  }

  function interpretScore(score) {
    if (score < 30) return { label: 'Low', color: '#059669', description: 'Well within capacity' }
    if (score < 60) return { label: 'Moderate', color: '#2563EB', description: 'Normal working range' }
    if (score < 80) return { label: 'High', color: '#D97706', description: 'Approaching saturation' }
    return { label: 'Critical', color: '#DC2626', description: 'Near maximum capacity' }
  }

  // ── NEW: Update from Firebase data (called after Kaggle runs) ──────────
  function updateFromFirebase(meta) {
    if (!meta) return

    // Normalize field names (Kaggle uses cds_* prefix)
    _cds = {
      ..._cds,
      ...meta,
      // Map cds_* to plain names for backward compat — use || to reject 0 (means unanalysed)
      executive: meta.cds_executive || _cds.executive,
      language: meta.cds_language || _cds.language,
      visual: meta.cds_visual || _cds.visual,
      analysed: true
    }
    computeParams()

    console.log(`[StudyTwin TRIBE] Loaded from Firebase (mode=${meta.tribe_mode || 'unknown'}):`,
      `Exec=${_cds.executive} Lang=${_cds.language} Vis=${_cds.visual}`,
      `Duration=${_cds.recommended_duration}min Threshold=${_cds.recommended_threshold}`)

    // Broadcast to all TRIBE subscribers
    _subs.forEach(fn => fn({ ..._cds }))
  }

  let _subs = []

  return {
    get() { return { ..._cds } },
    getDominantRegion,
    interpretScore,
    updateFromFirebase,
    _subs,
    subscribe(fn) {
      _subs.push(fn)
      fn({ ..._cds })
      return () => { _subs = _subs.filter(s => s !== fn) }
    }
  }
})()

window.TRIBE = TRIBE;
window.ST = ST;
window.Spring = Spring;
window.loadThree = loadThree;
window.initAntigravityBrain = initAntigravityBrain;
window.renderNav = renderNav;
window.renderFooter = renderFooter;
window.initScrollReveal = initScrollReveal;

window.initLoadChart = function() {
  const canvas = document.getElementById('loadChart');
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  
  if (window.Chart) {
    Chart.defaults.color = '#9CA3AF';
    Chart.defaults.font.family = "'Inter',sans-serif";
    Chart.defaults.font.size = 11;
  }
  
  const g = ctx.createLinearGradient(0, 0, 0, 148);
  g.addColorStop(0, 'rgba(37,99,235,0.18)'); 
  g.addColorStop(1, 'rgba(37,99,235,0)');
  
  // 'zero' dataset initialized
  const zeroData = Array(90).fill(0);
  
  return new Chart(ctx, {
    type: 'line',
    data: { 
      labels: Array(90).fill(''), 
      datasets: [{ 
        data: zeroData, 
        borderColor: '#2563EB', 
        borderWidth: 2, 
        backgroundColor: g, 
        fill: true, 
        tension: 0.4, 
        pointRadius: 0, 
        spanGaps: false 
      }] 
    },
    options: { 
      responsive: true, 
      maintainAspectRatio: false,
      animation: false, 
      scales: { 
        y: { min: 0, max: 100, grid: { color: 'rgba(0,0,0,.05)' }, ticks: { stepSize: 25 } }, 
        x: { display: false } 
      }, 
      plugins: { 
        legend: { display: false }, 
        tooltip: { enabled: false } 
      } 
    }
  });
};
