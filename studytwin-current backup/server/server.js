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
const multer  = require('multer');
const cors    = require('cors');
const axios   = require('axios');
const admin   = require('firebase-admin');

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
      credential:  admin.credential.cert(serviceAccount),
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
    const result  = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  // Plain text fallback
  return buffer.toString('utf-8');
}

// ── KAGGLE TRIGGER ──────────────────────────────────────────────
async function triggerKaggleNotebook() {
  const username   = process.env.KAGGLE_USERNAME;
  const key        = process.env.KAGGLE_KEY;
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

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

// GET /health
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    firebase:  !!db,
    kaggle:    !!(process.env.KAGGLE_USERNAME && process.env.KAGGLE_KEY),
    gemini_ai: !!process.env.GEMINI_API_KEY
  });
});

// POST /analyze
// Header: Authorization: {uid}
// Body: multipart with file (PDF/DOCX/TXT) or text field + title
app.post('/analyze', upload.single('file'), async (req, res) => {
  try {
    const uid = req.headers.authorization || req.body.uid;
    if (!uid) {
      return res.status(400).json({ error: 'User UID required in Authorization header or body' });
    }

    let text  = '';
    let title = req.body.title || 'Study Material';

    if (req.file) {
      console.log(`Extracting text from: ${req.file.originalname} (${req.file.mimetype})`);
      text  = await extractTextFromBuffer(req.file.buffer, req.file.mimetype, req.file.originalname);
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

    // Truncate to 5000 chars for Kaggle LITE mode
    const truncated = text.length > 5000 ? text.substring(0, 5000) + '...' : text;
    console.log(`Writing ${truncated.length} chars to Firebase for UID: ${uid.substring(0, 8)}...`);

    if (!db) {
      return res.status(500).json({ error: 'Firebase not configured. Check FIREBASE_SERVICE_ACCOUNT env var.' });
    }

    // Write study text for Kaggle to read
    await db.ref(`/pending_analysis/${uid}`).set({
      text:         truncated,
      title:        title,
      status:       'pending',
      submitted_at: Date.now(),
      char_count:   truncated.length
    });

    // Write config so Kaggle Cell 3 knows which UID to process
    await db.ref('/config/current_analysis').set({
      uid:          uid,
      status:       'pending',
      submitted_at: Date.now(),
      material:     title
    });

    console.log('✅ Firebase write complete');

    const kaggleTriggered = await triggerKaggleNotebook();

    res.status(202).json({
      message:          'Analysis submitted',
      uid:              uid,
      title:            title,
      chars_extracted:  truncated.length,
      kaggle_triggered: kaggleTriggered,
      note: kaggleTriggered
        ? 'Kaggle notebook triggered — results in 3-8 minutes'
        : 'Firebase updated — please run Kaggle notebook manually to see results',
      estimated_minutes: 5
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

    const uid  = req.params.uid;
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
app.post('/insights', async (req, res) => {
  const FALLBACK_INSIGHTS = [
    'Your cognitive load is being monitored in real time.',
    'Stay hydrated and take short breaks every 20-25 minutes.',
    'If load climbs above 70, consider switching to lighter review material.'
  ];

  try {
    const {
      cli_history   = [],
      gsr_history   = [],
      rmssd_history = [],
      cds_scores    = {},
      current_state = 'focused',
      blink_rate    = 13
    } = req.body;

    const avgCLI    = cli_history.length
      ? (cli_history.reduce((a, b) => a + b, 0) / cli_history.length).toFixed(1) : 50;
    const recentCLI = cli_history.length >= 10
      ? (cli_history.slice(-10).reduce((a, b) => a + b, 0) / 10).toFixed(1) : avgCLI;
    const trend     = parseFloat(recentCLI) > parseFloat(avgCLI) + 5 ? 'rising'
                    : parseFloat(recentCLI) < parseFloat(avgCLI) - 5 ? 'falling' : 'stable';

    const lastHRV = rmssd_history.length ? rmssd_history[rmssd_history.length - 1] : null;
    const lastGSR = gsr_history.length   ? gsr_history[gsr_history.length - 1]     : null;

    const prompt = `You analyze biosignal data from a student using a cognitive load wearable.

STATE: ${current_state}
CLI average (5 min): ${avgCLI}/100
CLI trend: ${trend}
Recent CLI: ${recentCLI}/100
HRV RMSSD: ${lastHRV ? lastHRV.toFixed(1) + 'ms' : 'N/A'}
GSR deviation: ${lastGSR ? lastGSR.toFixed(1) + '%' : 'N/A'} above baseline
Blink rate: ${blink_rate}/min
Brain circuits: Executive ${cds_scores.cds_executive || 60}%, Language ${cds_scores.cds_language || 50}%, Visual ${cds_scores.cds_visual || 35}%

Give EXACTLY 3 plain-English observations (no medical jargon). Each 1-2 sentences, actionable, specific to these numbers.
OUTPUT FORMAT: JSON array of exactly 3 strings only. No extra text, no markdown, just the raw JSON array.`;

    const rawText = await callGeminiInsights(prompt);

    let insights = null;
    if (rawText) {
      try {
        const match = rawText.match(/\[[\s\S]*?\]/);
        insights = match ? JSON.parse(match[0]) : null;
      } catch (e) {
        console.warn('Gemini JSON parse issue, using computed fallback');
      }
    }

    if (!Array.isArray(insights) || insights.length < 3) {
      insights = [
        `Cognitive load at ${avgCLI}/100 and ${trend} — currently in ${current_state} state.`,
        'Monitor HRV and skin response for further load signals.',
        'Continue current study pace and watch for rising CLI trend.'
      ];
    }

    res.json({ insights, ai_provider: 'google_gemini_2.0_flash' });

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
  console.log(`   Gemini AI: ${process.env.GEMINI_API_KEY  ? '✅ FREE key set' : '⚠ no key — using fallback'}\n`);
});