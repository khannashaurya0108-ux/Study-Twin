/* ═══════════════════════════════════════════════════════════════
   STUDYTWIN — Backend Server (Phase 5B)
   Handles: PDF/DOCX text extraction, Firebase write,
   Kaggle notebook trigger, Google Gemini AI insights

   FREE AI: Google Gemini 2.0 Flash (no credit card, 1500 req/day)
   Get API key FREE at: aistudio.google.com/app/apikey

   Deploy to: Render.com (free tier) or run locally
   Port: 3001 (local) or auto-assigned (Render)
═══════════════════════════════════════════════════════════════ */

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();

// ── MIDDLEWARE ──────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// Multer: accept files up to 50MB, held in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ── FIREBASE ADMIN INIT ─────────────────────────────────────────
let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  }
  db = admin.database();
  console.log('✅ Firebase Admin connected');
} catch (err) {
  console.error('❌ Firebase Admin init failed:', err.message);
  console.error('   Set FIREBASE_SERVICE_ACCOUNT and FIREBASE_DATABASE_URL in .env');
}

// ── TEXT EXTRACTION ─────────────────────────────────────────────
async function extractTextFromBuffer(buffer, mimetype, filename) {
  const name = (filename || '').toLowerCase();

  // PDF
  if (mimetype === 'application/pdf' || name.endsWith('.pdf')) {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    return data.text;
  }

  // DOCX / DOC
  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimetype === 'application/msword' ||
    name.endsWith('.docx') || name.endsWith('.doc')
  ) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  // Plain text fallback
  return buffer.toString('utf-8');
}

// ── KAGGLE TRIGGER ──────────────────────────────────────────────
async function triggerKaggleNotebook() {
  const username = process.env.KAGGLE_USERNAME;
  const key = process.env.KAGGLE_KEY;
  const kernelSlug = process.env.KAGGLE_KERNEL_SLUG;

  if (!username || !key || !kernelSlug) {
    console.warn('⚠ Kaggle credentials not set — manual notebook run required');
    return false;
  }

  try {
    const auth = Buffer.from(`${username}:${key}`).toString('base64');
    const [kUser, kSlug] = kernelSlug.includes('/')
      ? kernelSlug.split('/')
      : [username, kernelSlug];

    const response = await axios.post(
      `https://www.kaggle.com/api/v1/kernels/${kUser}/${kSlug}/run`,
      {},
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    console.log(`✅ Kaggle notebook triggered: ${response.status}`);
    return true;
  } catch (err) {
    console.warn(`⚠ Kaggle trigger failed (${err.response?.status || err.message})`);
    console.warn('   → Please run the Kaggle notebook manually');
    return false;
  }
}

// ── GOOGLE GEMINI AI (FREE) ─────────────────────────────────────
// Get your FREE key at: aistudio.google.com/app/apikey
// Free tier: 1500 requests/day, no credit card needed
async function callGeminiInsights(prompt) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return null;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 400, temperature: 0.7 }
      })
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

// ── LITE NLP CDS ANALYSIS (replaces Kaggle for base mode) ──────────────────
const EXECUTIVE_WORDS = new Set([
  'algorithm', 'solve', 'derive', 'prove', 'optimize', 'analyze', 'calculate',
  'theorem', 'equation', 'formula', 'logic', 'reasoning', 'compute', 'function',
  'integral', 'differential', 'matrix', 'vector', 'probability', 'hypothesis',
  'experiment', 'method', 'procedure', 'strategy', 'evaluate', 'determine',
  'implement', 'design', 'architecture', 'framework', 'system', 'module', 'component',
  'circuit', 'signal', 'frequency', 'amplitude', 'voltage', 'current', 'resistance',
  'transform', 'convolution', 'fourier', 'laplace', 'polynomial', 'coefficient',
  'derivative', 'gradient', 'convergence', 'iteration', 'recursion', 'complexity',
  'invariant', 'constraint', 'parameter', 'variable', 'operator', 'eigenvalue'
]);

const LANGUAGE_WORDS = new Set([
  'define', 'explain', 'describe', 'discuss', 'state', 'outline', 'summarize',
  'write', 'essay', 'paragraph', 'sentence', 'grammar', 'vocabulary', 'concept',
  'theory', 'principle', 'definition', 'meaning', 'context', 'interpret',
  'literary', 'narrative', 'argument', 'evidence', 'source', 'reference',
  'documentation', 'report', 'review', 'introduction', 'conclusion', 'compare',
  'contrast', 'analysis', 'significance', 'implication', 'perspective', 'describe',
  'elaborate', 'justify', 'quote', 'paraphrase', 'annotate', 'cite', 'mention'
]);

const VISUAL_WORDS = new Set([
  'diagram', 'figure', 'graph', 'plot', 'chart', 'image', 'picture', 'draw',
  'sketch', 'illustration', 'visualize', 'spatial', 'geometry', 'shape',
  'triangle', 'circle', 'rectangle', 'angle', 'coordinate', 'axis', 'curve',
  'topology', 'map', 'render', 'display', 'pixel', 'pattern', 'symmetry',
  'transform', 'rotation', 'reflection', 'simulation', 'model', 'schematic',
  'waveform', 'spectrum', 'histogram', 'contour', 'mesh', 'cross-section'
]);

function computeLiteNLP(text, title = '') {
  const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const total = Math.max(words.length, 1);

  let execCount = 0, langCount = 0, visCount = 0;
  for (const w of words) {
    if (EXECUTIVE_WORDS.has(w)) execCount++;
    if (LANGUAGE_WORDS.has(w)) langCount++;
    if (VISUAL_WORDS.has(w)) visCount++;
  }

  // Density → score: calibrated so ~0.006 density ≈ 70 score
  const toScore = (count) => {
    const density = count / total;
    return Math.min(100, Math.max(5, Math.round(density * 9000 + 15)));
  };

  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);
  const avgSentLen = sentences.length
    ? sentences.reduce((s, ln) => s + ln.split(/\s+/).length, 0) / sentences.length
    : 15;

  return {
    cds_executive: toScore(execCount),
    cds_language: toScore(langCount),
    cds_visual: visCount > 1 ? toScore(visCount) : 10,
    tribe_mode: 'lite_nlp',
    word_count: total,
    sentence_count: sentences.length,
    avg_sent_len: Math.round(avgSentLen * 10) / 10
  };
}

function computeSessionParams(cds) {
  const exec = cds.cds_executive;
  const regions = {
    Executive: exec,
    Language: cds.cds_language,
    Visual: cds.cds_visual
  };
  const dominant = Object.entries(regions).sort(([, a], [, b]) => b - a)[0][0];
  const recs = {
    Executive: 'Switch to visual content — diagrams, flowcharts, or summary videos to rest the prefrontal cortex.',
    Language: 'Switch to numerical content — equations, graphs, or problem sets. Reduce dense reading.',
    Visual: 'Switch to audio or text-light reading. Reduce diagram and animation-heavy material.'
  };
  return {
    dominant_region: dominant,
    recommended_duration: Math.round(32 - (exec / 100) * 16),   // 16–32 min
    overload_threshold: Math.round(80 - (exec / 100) * 22),   // 58–80
    routing_recommendation: recs[dominant]
  };
}

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

// GET /health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    firebase: !!db,
    kaggle: !!(process.env.KAGGLE_USERNAME && process.env.KAGGLE_KEY),
    gemini_ai: !!process.env.GEMINI_API_KEY
  });
});

// POST /analyze
app.post('/analyze', upload.single('file'), async (req, res) => {
  try {
    const uid = req.headers.authorization || req.body.uid;
    if (!uid) {
      return res.status(400).json({ error: 'User UID required in Authorization header or body' });
    }

    let text = '';
    let title = req.body.title || 'Study Material';

    if (req.file) {
      console.log(`Extracting text from: ${req.file.originalname} (${req.file.mimetype})`);
      text = await extractTextFromBuffer(req.file.buffer, req.file.mimetype, req.file.originalname);
      title = req.body.title || req.file.originalname.replace(/\.[^.]+$/, '');
    } else if (req.body.text) {
      text = req.body.text;
    } else {
      return res.status(400).json({ error: 'No file or text provided' });
    }

    text = text.trim();
    if (!text) {
      return res.status(400).json({ error: 'Could not extract text — file may be empty or image-only PDF' });
    }

    const truncated = text.length > 5000 ? text.substring(0, 5000) + '...' : text;
    console.log(`Processing ${truncated.length} chars for UID: ${uid.substring(0, 8)}...`);

    if (!db) {
      return res.status(500).json({ error: 'Firebase not configured. Check FIREBASE_SERVICE_ACCOUNT env var.' });
    }

    // ── Write pending marker ──────────────────────────────────────────────────
    await db.ref(`/pending_analysis/${uid}`).set({
      text: truncated,
      title: title,
      status: 'processing',
      submitted_at: Date.now(),
      char_count: truncated.length
    });

    await db.ref('/config/current_analysis').set({
      uid, status: 'processing', submitted_at: Date.now(), material: title
    });

    // ── Run LITE NLP analysis immediately (server-side, no Kaggle needed) ────
    console.log('[TRIBE LITE] Running server-side NLP analysis...');
    const cdsScores = computeLiteNLP(truncated, title);
    const sessionParams = computeSessionParams(cdsScores);

    const metadata = {
      ...cdsScores,
      ...sessionParams,
      material: title,
      analysed_at: Date.now(),
      analysed_at_iso: new Date().toISOString(),
      text_length: truncated.length
    };

    console.log('[TRIBE LITE] Scores:', JSON.stringify(cdsScores));

    // ── Write metadata using Admin SDK (bypasses security rules) ─────────────
    try {
      await db.ref(`/sessions/${uid}/metadata`).set(metadata);
      await db.ref(`/pending_analysis/${uid}`).update({ status: 'complete' });
      console.log(`✅ Metadata written to Firebase for UID: ${uid.substring(0, 8)}`);
    } catch (dbErr) {
      console.error('Firebase metadata write error:', dbErr.message);
    }

    res.status(202).json({
      message: 'Analysis complete',
      uid,
      title,
      chars_extracted: truncated.length,
      kaggle_triggered: false,
      lite_nlp_complete: true,
      cds_preview: cdsScores,
      note: 'Server-side LITE NLP analysis complete. Dashboard updates immediately.',
      estimated_minutes: 0
    });

  } catch (err) {
    console.error('POST /analyze error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// GET /analyze/status/:uid
// Frontend polls every 10s after upload
app.get('/analyze/status/:uid', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Firebase not configured' });

    const uid = req.params.uid;
    const snap = await db.ref(`/pending_analysis/${uid}`).once('value');
    const data = snap.val();

    if (!data) return res.json({ status: 'not_found' });

    const status = data.status || 'pending';
    if (status === 'complete') {
      const metaSnap = await db.ref(`/sessions/${uid}/metadata`).once('value');
      const metadata = metaSnap.val();
      return res.json({ status: 'complete', metadata });
    }

    res.json({ status, submitted_at: data.submitted_at, title: data.title });

  } catch (err) {
    console.error('GET /analyze/status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /insights
// Uses Google Gemini 2.0 Flash (FREE — aistudio.google.com)
// Returns 4 insights: right_now, suggestion, trend, tribe_alert
app.post('/insights', async (req, res) => {
  const FALLBACK_INSIGHTS = [
    'Your cognitive load is being monitored in real time.',
    'Stay hydrated and take short breaks every 20-25 minutes.',
    'If load climbs above 70, consider switching to lighter review material.',
    'All brain circuits operating within normal parameters for this material.'
  ];

  try {
    const {
      cli_history = [],
      gsr_history = [],
      rmssd_history = [],
      cds_scores = {},
      current_state = 'focused',
      blink_rate = 13,
      session_seconds = 0,
      dominant_region = null,
      routing_recommendation = null
    } = req.body;

    // ── Compute statistics ──────────────────────────────────────────────────
    const avgCLI = cli_history.length
      ? (cli_history.reduce((a, b) => a + b, 0) / cli_history.length).toFixed(1)
      : 50;
    const recentCLI = cli_history.length >= 10
      ? (cli_history.slice(-10).reduce((a, b) => a + b, 0) / 10).toFixed(1)
      : avgCLI;
    const trend = parseFloat(recentCLI) > parseFloat(avgCLI) + 5 ? 'rising'
      : parseFloat(recentCLI) < parseFloat(avgCLI) - 5 ? 'falling'
      : 'stable';

    // Peak CLI in the window
    const peakCLI = cli_history.length ? Math.max(...cli_history) : 50;

    // HRV and GSR latest values
    const avgHRV = rmssd_history.length
      ? (rmssd_history.slice(-10).reduce((a, b) => a + b, 0) / Math.min(rmssd_history.length, 10)).toFixed(1)
      : null;
    const avgGSR = gsr_history.length
      ? (gsr_history.slice(-10).reduce((a, b) => a + b, 0) / Math.min(gsr_history.length, 10)).toFixed(1)
      : null;

    const sessionMin = Math.round(session_seconds / 60);

    // ── Determine dominant circuit with recommendation ──────────────────────
    const exec = cds_scores.cds_executive || 60;
    const lang = cds_scores.cds_language  || 50;
    const vis  = cds_scores.cds_visual    || 35;

    const circuitMap = { Executive: exec, Language: lang, Visual: vis };
    const topCircuit = dominant_region
      || Object.entries(circuitMap).sort(([,a],[,b]) => b - a)[0][0];

    const tribeRecs = {
      Executive: 'Switch to visual content — diagrams or summary videos to rest the prefrontal cortex.',
      Language:  'Switch to numerical content — equations or graphs. Reduce dense reading.',
      Visual:    'Switch to audio or text-light reading. Reduce diagram and animation-heavy material.'
    };
    const tribeRec = routing_recommendation || tribeRecs[topCircuit] || tribeRecs.Executive;

    // ── Build Gemini prompt ─────────────────────────────────────────────────
    const prompt = `You analyze biosignal data from a student using a wearable cognitive load monitor (StudyTwin).

CURRENT DATA:
- State: ${current_state.toUpperCase()} | CLI: ${avgCLI}/100 (peak ${peakCLI}, trend: ${trend})
- Recent CLI (last 10 readings): ${recentCLI}/100
- HRV RMSSD: ${avgHRV ? avgHRV + 'ms' : 'N/A'} | GSR deviation: ${avgGSR ? avgGSR + '%' : 'N/A'} above baseline
- Blink rate: ${blink_rate}/min (normal range: 10-20/min; below 10 signals fatigue)
- Session time: ${sessionMin} min elapsed
- Brain circuits (TRIBE v2): Executive ${exec}%, Language ${lang}%, Visual ${vis}%
- Dominant circuit under demand: ${topCircuit}

Generate EXACTLY 4 plain-English observations. No medical jargon. Each 1-2 sentences.
Observation 0 (RIGHT NOW): What is the student experiencing cognitively right this moment? Be specific to the numbers.
Observation 1 (SUGGESTION): One concrete, immediately actionable thing they should do (e.g. "take a 2-min walk", "drink water", "try a practice problem"). Make it specific.
Observation 2 (TREND): What pattern do the last 5 minutes show? Is load accelerating, holding, or recovering?
Observation 3 (TRIBE ALERT): Which brain circuit is under load right now and what specific rest activity will restore it? Reference the dominant circuit (${topCircuit}).

CRITICAL OUTPUT FORMAT: JSON array of exactly 4 strings ONLY. No markdown, no preamble, no explanation. Just: ["str1","str2","str3","str4"]`;

    console.log(`[Insights] Calling Gemini for UID state=${current_state} CLI=${avgCLI} trend=${trend}`);
    const rawText = await callGeminiInsights(prompt);

    // ── Parse Gemini response ──────────────────────────────────────────────
    let insights = null;
    if (rawText) {
      try {
        // Try to find JSON array in response (handles markdown wrapping)
        const match = rawText.match(/\[[\s\S]*?\]/);
        if (match) {
          insights = JSON.parse(match[0]);
        }
      } catch (e) {
        console.warn('[Insights] Gemini JSON parse failed, building computed fallback');
      }
    }

    // ── Computed fallback (always meaningful, uses real data) ───────────────
    if (!Array.isArray(insights) || insights.length < 4) {
      const stateMessages = {
        calm:       'Load is below baseline — you are relaxed and absorbing information well.',
        focused:    `Cognitive load at ${avgCLI}/100 — you are in the optimal engagement zone.`,
        elevated:   `Load rising to ${avgCLI}/100 — skin conductance and HRV indicate early stress.`,
        overloaded: `Load at ${avgCLI}/100 — cognitive overload detected, continuing reduces retention.`
      };
      const suggestions = {
        calm:       'This is a great window for tackling harder problems — push into the difficult material now.',
        focused:    'Maintain your current pace. A sip of water and a quick stretch in the next few minutes will sustain this.',
        elevated:   'Take a 2-minute breathing pause: 4 counts in, 6 counts out. Do not skip this.',
        overloaded: 'Stop now and step away from the screen for at least 5 minutes. Your working memory is saturated.'
      };
      const trendMsg = trend === 'rising'
        ? `Load has climbed ${(parseFloat(recentCLI) - parseFloat(avgCLI)).toFixed(1)} points in the last 2 minutes — address this before it peaks.`
        : trend === 'falling'
        ? 'Load is recovering — the adaptation is working. Hold this easier pace for another 2 minutes.'
        : `Load has been stable at ${avgCLI}/100 for 5 minutes — a consistent and sustainable session.`;

      insights = [
        stateMessages[current_state] || stateMessages.focused,
        suggestions[current_state]   || suggestions.focused,
        trendMsg,
        (current_state === 'elevated' || current_state === 'overloaded')
          ? `${topCircuit} circuit is under high demand. ${tribeRec}`
          : `All brain circuits operating within normal parameters. ${topCircuit} circuit is the most active at ${circuitMap[topCircuit]}%.`
      ];
    }

    // Ensure exactly 4 entries
    while (insights.length < 4) insights.push(FALLBACK_INSIGHTS[insights.length]);
    insights = insights.slice(0, 4).map(s => String(s).trim());

    console.log(`[Insights] Response: ${insights.map(s => s.substring(0,40)).join(' | ')}`);
    res.json({ insights, ai_provider: rawText ? 'google_gemini_2.0_flash' : 'computed_fallback' });

  } catch (err) {
    console.error('POST /insights error:', err.message);
    res.json({ insights: FALLBACK_INSIGHTS, ai_provider: 'fallback' });
  }
});

// ── START ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🧠 StudyTwin Server running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Firebase:  ${db ? '✅ connected' : '❌ not configured'}`);
  console.log(`   Kaggle:    ${process.env.KAGGLE_USERNAME ? '✅ credentials set' : '⚠ manual trigger only'}`);
  console.log(`   Gemini AI: ${process.env.GEMINI_API_KEY ? '✅ FREE key set' : '⚠ no key — using fallback'}\n`);
});