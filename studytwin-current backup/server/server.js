'use strict';
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const pdfParse = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 3001;

// ── MIDDLEWARE ──────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Multer: hold PDF in memory, max 10 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: function (_req, file, cb) {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are accepted'), false);
    }
  }
});

// ── FIREBASE ADMIN INIT ─────────────────────────────────────────
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('FIREBASE_SERVICE_ACCOUNT is missing from .env');
  process.exit(1);
}
if (!process.env.FIREBASE_DATABASE_URL) {
  console.error('FIREBASE_DATABASE_URL is missing from .env');
  process.exit(1);
}

var serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT — must be valid JSON on one line');
  console.error('Parse error:', e.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

var db = admin.database();
console.log('Firebase Admin SDK initialised');

// ── GET /health ─────────────────────────────────────────────────
app.get('/health', function (_req, res) {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    project: 'StudyTwin Server v1.0'
  });
});

// ── POST /analyze ───────────────────────────────────────────────
app.post('/analyze', upload.single('file'), async function (req, res) {
  try {
    var uid = req.body.uid || req.headers['authorization'];
    if (!uid || uid.length < 10) {
      return res.status(400).json({ error: 'uid is required' });
    }

    var extractedText = '';
    var materialTitle = req.body.title || 'Study Material';

    if (req.file) {
      console.log('PDF received: ' + req.file.originalname + ' for uid ' + uid);
      var pdfData = await pdfParse(req.file.buffer);
      extractedText = pdfData.text || '';
      console.log('Extracted ' + extractedText.length + ' chars from PDF');
    } else if (req.body.text && req.body.text.trim().length > 0) {
      extractedText = req.body.text.trim();
      console.log('Plain text received: ' + extractedText.length + ' chars for uid ' + uid);
    } else {
      return res.status(400).json({ error: 'Provide a PDF file or plain text' });
    }

    if (extractedText.length < 80) {
      return res.status(400).json({ error: 'Content too short' });
    }

    var textToAnalyse = extractedText.substring(0, 50000);

    await db.ref('/pending_analysis/' + uid + '/input').set({
      text: textToAnalyse,
      title: materialTitle,
      status: 'pending',
      submitted_at: Date.now(),
      char_count: textToAnalyse.length,
      uid: uid
    });
    console.log('Written to /pending_analysis/' + uid + '/input');

    triggerKaggleNotebook(uid).then(function () {
      console.log('Kaggle notebook triggered for uid ' + uid);
    }).catch(function (err) {
      console.warn('Kaggle trigger failed: ' + err.message);
    });

    return res.status(202).json({
      message: 'Analysis started',
      uid: uid,
      status: 'pending',
      poll_url: '/analyze/status/' + uid
    });

  } catch (err) {
    console.error('/analyze error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /analyze/status/:uid ────────────────────────────────────
app.get('/analyze/status/:uid', async function (req, res) {
  try {
    var uid = req.params.uid;
    var inputSnap = await db.ref('/pending_analysis/' + uid + '/input').once('value');
    var inputData = inputSnap.val();

    if (!inputData) {
      return res.status(404).json({ error: 'No analysis record found' });
    }

    if (inputData.status === 'complete') {
      var metaSnap = await db.ref('/sessions/' + uid + '/metadata').once('value');
      var meta = metaSnap.val() || {};
      return res.json({
        status: 'complete',
        cds_executive: meta.cds_executive || 0,
        cds_language: meta.cds_language || 0,
        cds_visual: meta.cds_visual || 0,
        recommended_duration: meta.recommended_duration || 25,
        overload_threshold: meta.overload_threshold || 76,
        dominant_region: meta.dominant_region || 'Executive',
        tribe_mode: meta.tribe_mode || 'lite_nlp',
        analysed_at: meta.analysed_at || null
      });
    }

    if (inputData.status === 'error') {
      return res.json({ status: 'error', message: inputData.error_message || 'Analysis failed' });
    }

    return res.json({ status: inputData.status || 'pending', submitted_at: inputData.submitted_at });

  } catch (err) {
    console.error('/analyze/status error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /insights ──────────────────────────────────────────────
app.post('/insights', async function (req, res) {
  var FALLBACK = [
    'Your biosignals are being monitored continuously.',
    'Maintain your current pace — session running normally.',
    'Take a 2-minute breathing break if you feel mental fatigue.'
  ];

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.json({ insights: FALLBACK, fallback: true });
    }

    var cli_history = req.body.cli_history || [];
    var gsr_history = req.body.gsr_history || [];
    var rmssd_history = req.body.rmssd_history || [];
    var user_baseline = req.body.user_baseline || {};
    var cds_executive = req.body.cds_executive || 0;
    var cds_language = req.body.cds_language || 0;
    var cds_visual = req.body.cds_visual || 0;
    var current_state = req.body.current_state || 'focused';
    var blink_rate_current = req.body.blink_rate_current || 15;

    if (!Array.isArray(cli_history) || cli_history.length === 0) {
      return res.json({ insights: FALLBACK, fallback: true });
    }

    function avg(arr) {
      return arr.length ? Math.round(arr.reduce(function (a, b) { return a + b; }, 0) / arr.length) : null;
    }

    var cliAvg = avg(cli_history);
    var cliMax = Math.max.apply(null, cli_history);
    var rmssdAvg = avg(rmssd_history);
    var gsrAvg = gsr_history.length
      ? (gsr_history.reduce(function (a, b) { return a + b; }, 0) / gsr_history.length).toFixed(1)
      : null;

    var userPrompt = 'You are analyzing biosignal data from a student wearing StudyTwin.\n\n' +
      'BIOSIGNAL SUMMARY (last 5 minutes):\n' +
      '- Cognitive Load Index: avg=' + cliAvg + '/100, peak=' + cliMax + '/100, state="' + current_state + '"\n' +
      '- HRV RMSSD: avg=' + rmssdAvg + 'ms\n' +
      '- GSR deviation: avg=' + gsrAvg + '%\n' +
      '- Blink rate: ' + blink_rate_current + '/min\n\n' +
      'BRAIN CIRCUIT DEMAND:\n' +
      '- Executive: ' + cds_executive + '/100\n' +
      '- Language: ' + cds_language + '/100\n' +
      '- Visual: ' + cds_visual + '/100\n\n' +
      'Output ONLY a JSON array of exactly 3 short plain-English strings. No markdown. No medical language.';

    var response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: userPrompt }]
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: 15000
      }
    );

    var raw = response.data.content[0].text.trim();
    var insights;
    try {
      var cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      insights = JSON.parse(cleaned);
      if (!Array.isArray(insights) || insights.length !== 3) throw new Error('Not a 3-element array');
    } catch (parseErr) {
      console.warn('Claude parse failed:', parseErr.message);
      return res.json({ insights: FALLBACK, fallback: true });
    }

    return res.json({ insights: insights });

  } catch (err) {
    console.error('/insights error:', err.message);
    return res.json({ insights: FALLBACK, fallback: true });
  }
});

// ── Kaggle trigger ──────────────────────────────────────────────
async function triggerKaggleNotebook(_uid) {
  var notebookId = process.env.KAGGLE_NOTEBOOK_ID;
  if (!notebookId) throw new Error('KAGGLE_NOTEBOOK_ID not set');

  var parts = notebookId.split('/');
  var kaggleUser = parts[0];
  var kernelSlug = parts[1];

  var response = await axios.post(
    'https://www.kaggle.com/api/v1/kernels',
    {
      id: kaggleUser + '/' + kernelSlug,
      newTitle: 'StudyTwin TRIBE Analysis',
      language: 'python',
      kernelType: 'notebook',
      isPrivate: true,
      enableGpu: true,
      enableInternet: true,
      datasetDataSources: [],
      kernelDataSources: [],
      competitionDataSources: []
    },
    {
      auth: { username: process.env.KAGGLE_USERNAME, password: process.env.KAGGLE_KEY },
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000
    }
  );

  return response.data;
}

// ── Global error handler ────────────────────────────────────────
app.use(function (err, _req, res, _next) {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message });
});

// ── Start ───────────────────────────────────────────────────────
app.listen(PORT, function () {
  console.log('StudyTwin Server is running on http://localhost:' + PORT + '/health');
});