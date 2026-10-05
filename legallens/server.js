const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { analyzeText } = require('./analyzer');

// Minimal .env loader (no extra dependency). Real environment variables win.
const envCandidates = [
  path.join(__dirname, '.env'),
  path.join(process.cwd(), '.env'),
  path.join(__dirname, '..', '..', '.env'),
];
for (const envPath of envCandidates) {
  try {
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
        if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* ignore read errors */ }
}
const { chat } = require('./llm');
const Tesseract = require('tesseract.js');
const xlsx = require('xlsx');
const nodemailer = require('nodemailer');

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore directory creation errors */ }

// ---- tiny JSON "database" (replace with Firestore later) ----
const load = () => {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    if (process.env.VERCEL) {
      try {
        const seeded = path.join(__dirname, 'data', 'db.json');
        if (fs.existsSync(seeded)) {
          const content = fs.readFileSync(seeded, 'utf8');
          fs.writeFileSync(DB_FILE, content);
          return JSON.parse(content);
        }
      } catch { /* ignore fallback load */ }
    }
    return { users: {}, documents: [] };
  }
};
const save = db => {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('[DB Save Error]', err.message);
  }
};

// Re-sync stored documents with updated analyzer rules on startup
try {
  const db = load();
  let changed = false;
  for (const d of (db.documents || [])) {
    if (d.text && d.text.length > 20) {
      d.analysis = analyzeText(d.text, d.name);
      changed = true;
    }
  }
  if (changed) save(db);
} catch { /* ignore startup sync error */ }

const app = express();

// =========================================================================
// SECURITY LAYER 1: Hide tech stack & set HTTP Security Headers
// =========================================================================
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  next();
});

// =========================================================================
// SECURITY LAYER 2: Origin & CSRF Guard for mutating requests (POST, PUT, DELETE)
// =========================================================================
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const origin = req.headers.origin || req.headers.referer;
    if (origin) {
      try {
        const originHost = new URL(origin).host;
        const reqHost = req.headers.host;
        if (originHost && reqHost && originHost !== reqHost) {
          return res.status(403).json({ error: 'Forbidden: Cross-origin request rejected' });
        }
      } catch {
        return res.status(403).json({ error: 'Forbidden: Invalid request origin' });
      }
    }
  }
  next();
});

// =========================================================================
// SECURITY LAYER 3: Rate Limiting & DoS Protection (Anti-Postman flood)
// =========================================================================
const ipRateLimits = new Map();
const uploadRateLimits = new Map();
const chatRateLimits = new Map();

// Periodic cleanup of stale rate limiter timestamps (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of ipRateLimits.entries()) {
    const fresh = times.filter(t => now - t < 60000);
    if (fresh.length === 0) ipRateLimits.delete(key);
    else ipRateLimits.set(key, fresh);
  }
  for (const [key, times] of uploadRateLimits.entries()) {
    const fresh = times.filter(t => now - t < 300000);
    if (fresh.length === 0) uploadRateLimits.delete(key);
    else uploadRateLimits.set(key, fresh);
  }
  for (const [key, times] of chatRateLimits.entries()) {
    const fresh = times.filter(t => now - t < 60000);
    if (fresh.length === 0) chatRateLimits.delete(key);
    else chatRateLimits.set(key, fresh);
  }
}, 300000);

function rateLimiter(limit, windowMs, map, errMsg) {
  return (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
    const key = (req.user?.uid ? req.user.uid + '_' : '') + ip;
    const now = Date.now();
    const hits = (map.get(key) || []).filter(t => now - t < windowMs);
    if (hits.length >= limit) {
      return res.status(429).json({ error: errMsg || 'Too many requests. Please wait a moment and try again.' });
    }
    map.set(key, [...hits, now]);
    next();
  };
}

// Global IP rate limit: max 120 requests per minute
app.use('/api', rateLimiter(120, 60000, ipRateLimits, 'Too many requests from this IP. Please slow down.'));

// =========================================================================
// SECURITY LAYER 4: Heavy Task Concurrency Limiting (OCR & Parser protection)
// =========================================================================
let activeUploadTasks = 0;
const MAX_CONCURRENT_UPLOADS = 2;

function checkUploadConcurrency(req, res, next) {
  if (activeUploadTasks >= MAX_CONCURRENT_UPLOADS) {
    return res.status(429).json({ error: 'Server is currently processing another document. Please wait a few seconds and try again.' });
  }
  activeUploadTasks++;
  let finished = false;
  const done = () => {
    if (!finished) {
      finished = true;
      activeUploadTasks = Math.max(0, activeUploadTasks - 1);
    }
  };
  res.on('finish', done);
  res.on('close', done);
  next();
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Serves public Firebase configuration dynamically from environment variables
// This prevents committing sensitive or private keys to source control / GitHub
function getClientFirebaseConfig() {
  return {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || '',
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || ''
  };
}

app.get('/api/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.send(`window.__FIREBASE_CONFIG__ = ${JSON.stringify(getClientFirebaseConfig())};`);
});

app.get('/api/firebase-config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json(getClientFirebaseConfig());
});

// Safe 15MB file size limit to prevent Heap Out-Of-Memory exhaustion
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isOk = /pdf|png|jpe?g|webp|tiff?|bmp|text\/plain|text\/csv|csv|excel|spreadsheetml/i.test(file.mimetype)
      || /\.(pdf|png|jpe?g|webp|tiff?|bmp|txt|csv|xlsx?)$/i.test(file.originalname);
    cb(isOk ? null : new Error('Supported file types: PDF, Images (PNG, JPG, WebP), Text (.txt), CSV, and Excel (.xlsx, .xls)'), isOk);
  },
});

// =========================================================================
// SECURITY LAYER 5: Magic Byte / Binary Signature Verification (Anti-MIME spoofing)
// =========================================================================
function validateFileSignature(buffer, originalname) {
  if (!buffer || buffer.length === 0) return { valid: false, reason: 'Uploaded file is empty.' };

  // Block Windows/DOS Executables (MZ header)
  if (buffer.length >= 2 && buffer[0] === 0x4D && buffer[1] === 0x5A) {
    return { valid: false, reason: 'Security Alert: Executable files (.exe/.dll) are strictly prohibited.' };
  }
  // Block Linux/Unix ELF Executables
  if (buffer.length >= 4 && buffer[0] === 0x7F && buffer[1] === 0x45 && buffer[2] === 0x4C && buffer[3] === 0x46) {
    return { valid: false, reason: 'Security Alert: Binary executable files are strictly prohibited.' };
  }
  // Block Shell Scripts (#!)
  if (buffer.length >= 2 && buffer[0] === 0x23 && buffer[1] === 0x21) {
    return { valid: false, reason: 'Security Alert: Shell scripts are not permitted.' };
  }

  const name = (originalname || '').toLowerCase();

  // PDF signature: must start with %PDF
  if (name.endsWith('.pdf')) {
    const isPdf = buffer.slice(0, 5).toString('ascii').startsWith('%PDF');
    if (!isPdf) return { valid: false, reason: 'File extension is .pdf but content is not a legitimate PDF document.' };
    return { valid: true };
  }

  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (name.endsWith('.png')) {
    const isPng = buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
    if (!isPng) return { valid: false, reason: 'File extension is .png but binary signature does not match PNG format.' };
    return { valid: true };
  }

  // JPEG signature: FF D8 FF
  if (/\.(jpe?g)$/.test(name)) {
    const isJpg = buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
    if (!isJpg) return { valid: false, reason: 'File extension is JPEG but binary signature does not match JPEG format.' };
    return { valid: true };
  }

  // WebP signature: RIFF .... WEBP
  if (name.endsWith('.webp')) {
    const isRiff = buffer.slice(0, 4).toString('ascii') === 'RIFF';
    const isWebp = buffer.slice(8, 12).toString('ascii') === 'WEBP';
    if (!isRiff || !isWebp) return { valid: false, reason: 'File is not a valid WebP image.' };
    return { valid: true };
  }

  // BMP signature: BM
  if (name.endsWith('.bmp')) {
    const isBmp = buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4D;
    if (!isBmp) return { valid: false, reason: 'File is not a valid BMP image.' };
    return { valid: true };
  }

  // TIFF signature: II* or MM*
  if (/\.(tiff?)$/.test(name)) {
    const isTiff = buffer.length >= 4 && ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2A) || (buffer[0] === 0x4D && buffer[1] === 0x4D && buffer[3] === 0x2A));
    if (!isTiff) return { valid: false, reason: 'File is not a valid TIFF image.' };
    return { valid: true };
  }

  // Excel .xlsx: Zip container (PK\x03\x04)
  if (name.endsWith('.xlsx')) {
    const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
    if (!isZip) return { valid: false, reason: 'File is not a valid Excel (.xlsx) spreadsheet.' };
    return { valid: true };
  }

  // Legacy Excel .xls: Compound File Binary or Zip
  if (name.endsWith('.xls')) {
    const isCfb = buffer.length >= 4 && buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0;
    const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
    if (!isCfb && !isZip) return { valid: false, reason: 'File is not a valid Excel (.xls) spreadsheet.' };
    return { valid: true };
  }

  // Text and CSV: ensure no embedded binary null bytes in initial sample
  if (name.endsWith('.txt') || name.endsWith('.csv')) {
    const sample = buffer.slice(0, Math.min(buffer.length, 1024));
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === 0x00) return { valid: false, reason: 'Binary file detected where plain text/CSV was expected.' };
    }
    return { valid: true };
  }

  return { valid: true };
}

async function extractTextFromFile(file) {
  const mime = (file.mimetype || '').toLowerCase();
  const name = (file.originalname || '').toLowerCase();

  // 1. PDF
  if (/pdf/.test(mime) || name.endsWith('.pdf')) {
    const data = await require('pdf-parse')(file.buffer);
    return data.text || '';
  }

  // 2. Excel spreadsheets (.xlsx, .xls, .xlsm, .csv)
  if (/excel|spreadsheetml|csv/.test(mime) || /\.(xlsx?|xlsm|csv)$/.test(name)) {
    try {
      const wb = xlsx.read(file.buffer, { type: 'buffer' });
      return wb.SheetNames.map(sheetName => {
        const sheet = wb.Sheets[sheetName];
        return `=== Sheet: ${sheetName} ===\n` + xlsx.utils.sheet_to_csv(sheet);
      }).join('\n\n');
    } catch {
      return file.buffer.toString('utf8');
    }
  }

  // 3. Plain text
  if (/text\/plain/.test(mime) || name.endsWith('.txt')) {
    return file.buffer.toString('utf8');
  }

  // 4. Images with OCR (PNG, JPG, JPEG, WEBP, TIFF, BMP)
  if (/image\//.test(mime) || /\.(png|jpe?g|webp|tiff?|bmp)$/.test(name)) {
    console.log(`[OCR] Running OCR for ${file.originalname}...`);
    const { data } = await Tesseract.recognize(file.buffer, 'eng');
    console.log(`[OCR] Extracted ${data?.text?.length || 0} characters from ${file.originalname}`);
    return data?.text || '';
  }

  // Fallback
  return file.buffer.toString('utf8');
}

// ---- auth: verify Firebase ID token through Google's public lookup endpoint ----
async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authentication token' });
  if (!FIREBASE_API_KEY) {
    console.error('[Auth Configuration Error] FIREBASE_API_KEY is not defined in environment variables.');
    return res.status(500).json({ error: 'Server authentication is not configured. Please set FIREBASE_API_KEY in environment variables.' });
  }
  try {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }),
    });
    if (!r.ok) return res.status(401).json({ error: 'Invalid or expired token' });
    const u = (await r.json()).users?.[0];
    if (!u) return res.status(401).json({ error: 'User not found' });
    req.user = { uid: u.localId, email: u.email, name: u.displayName || '', photo: u.photoUrl || '' };
    next();
  } catch (e) { res.status(502).json({ error: 'Auth service unreachable' }); }
}

const mine = (db, uid) => db.documents.filter(d => d.uid === uid);
const brief = d => ({ id: d.id, name: d.name, label: d.analysis.label, type: d.analysis.type, status: d.analysis.status, attention: d.analysis.attention || 'none', uploadedAt: d.uploadedAt, topRisk: d.analysis.risks?.[0] || null });

// Risk score helper: returns overall Low/Medium/High
function riskScore(analysis) {
  const risks = analysis.risks || [];
  if (risks.some(r => r.severity === 'high')) return 'High';
  if (risks.some(r => r.severity === 'medium')) return 'Medium';
  if (risks.length > 0) return 'Low';
  return 'None';
}

// ---- routes ----
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Profile (stores optional phone / full name captured at sign up)
app.post('/api/auth/profile', auth, (req, res) => {
  const db = load();
  const { name, phone } = req.body || {};
  db.users[req.user.uid] = { ...db.users[req.user.uid], uid: req.user.uid, email: req.user.email, name: String(name || req.user.name).slice(0, 100), phone: String(phone || '').slice(0, 20) };
  save(db); res.json(db.users[req.user.uid]);
});
app.get('/api/me', auth, (req, res) => {
  const db = load(); res.json({ ...req.user, ...(db.users[req.user.uid] || {}) });
});

app.get('/api/dashboard', auth, (req, res) => {
  const docs = mine(load(), req.user.uid);
  const attention = docs.filter(d => d.analysis.attention && d.analysis.attention !== 'none')
    .sort((a, b) => (a.analysis.attention === 'high' ? 0 : 1) - (b.analysis.attention === 'high' ? 0 : 1));
  const today = new Date().toISOString().slice(0, 10);
  const deadlines = docs.flatMap(d => (d.analysis.deadlines || [])
    .filter(x => x.upcoming || x.date >= today)
    .map(x => ({ ...x, docId: d.id, docLabel: d.analysis.label })))
    .sort((a, b) => {
      if (a.isDeadline !== b.isDeadline) return a.isDeadline ? -1 : 1;
      return a.date.localeCompare(b.date);
    });
  res.json({
    counts: { documents: docs.length, attention: attention.length, deadlines: deadlines.filter(x => x.isDeadline).length || deadlines.length },
    attention: attention.map(brief),
    deadlines: deadlines.slice(0, 10),
    recent: docs.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)).slice(0, 5).map(brief),
  });
});

app.get('/api/documents', auth, (req, res) => res.json(mine(load(), req.user.uid).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)).map(brief)));

// Rate limit: max 15 document uploads per 5 minutes per user/IP
const uploadLimiter = rateLimiter(15, 300000, uploadRateLimits, 'Upload rate limit reached. Please wait a few minutes before uploading more documents.');

app.post('/api/documents', auth, uploadLimiter, checkUploadConcurrency, (req, res, next) => upload.single('file')(req, res, e => e ? res.status(400).json({ error: e.message }) : next()), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Security check: Validate actual binary signature (anti-MIME spoofing)
  const sigCheck = validateFileSignature(req.file.buffer, req.file.originalname);
  if (!sigCheck.valid) {
    return res.status(400).json({ error: sigCheck.reason });
  }

  let text = '';
  try {
    text = await extractTextFromFile(req.file);
  } catch (e) {
    console.error('[extractTextFromFile error]', e);
    text = '';
  }
  const cleanText = text.replace(/\s+/g, ' ').trim().slice(0, 60000);
  const analysis = analyzeText(cleanText, req.file.originalname);
  const doc = {
    id: crypto.randomUUID(),
    uid: req.user.uid,
    name: req.file.originalname,
    mime: req.file.mimetype,
    uploadedAt: new Date().toISOString(),
    text: cleanText,
    analysis
  };
  const db = load();
  db.documents.push(doc);
  save(db);
  res.status(201).json(brief(doc));
});

function getDoc(req, res) {
  const d = load().documents.find(x => x.id === req.params.id && x.uid === req.user.uid);
  if (!d) { res.status(404).json({ error: 'Document not found' }); return null; }
  return d;
}
app.get('/api/documents/:id', auth, (req, res) => { const d = getDoc(req, res); if (d) res.json({ ...brief(d), analysis: d.analysis }); });
for (const part of ['summary', 'risks', 'deadlines', 'actions', 'evidence']) {
  app.get(`/api/documents/:id/${part}`, auth, (req, res) => {
    const d = getDoc(req, res); if (!d) return;
    const a = d.analysis;
    res.json(part === 'summary' ? { summary: a.summary, simple: a.simple, label: a.label, wordCount: a.wordCount } : { [part]: a[part] });
  });
}

// Chatbot: answers questions about one document. Rate limited per user/IP.
const chatLimiter = rateLimiter(10, 60000, chatRateLimits, 'Too many questions in a short time. Please wait a minute before asking again.');

// Helper to sanitize chat inputs against control characters and null bytes
function sanitizeInput(str) {
  return String(str || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, 1000);
}

app.post('/api/documents/:id/chat', auth, chatLimiter, async (req, res) => {
  const d = getDoc(req, res); if (!d) return;
  const message = sanitizeInput(req.body?.message);
  if (!message) return res.status(400).json({ error: 'Please type a valid question.' });

  // Fallback if older upload had no stored text
  const a = d.analysis;
  const fallback = [a.summary, ...(a.risks || []).map(r => `${r.title}: ${r.evidence}`), ...(a.deadlines || []).map(x => `${x.date}: ${x.evidence}`)].join('\n');
  const documentText = (d.text || fallback || '').slice(0, 24000);
  if (!documentText) return res.status(422).json({ error: 'No readable text in this document to answer from.' });
  try {
    const history = Array.isArray(req.body?.history) ? req.body.history.filter(m => m && typeof m.content === 'string') : [];
    res.json({ reply: await chat({ documentText, label: a.label, history, message, lang: String(req.body?.lang || '') }) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// General chatbot: assists with legal queries even without a specific document.
app.post('/api/chat', auth, chatLimiter, async (req, res) => {
  const message = sanitizeInput(req.body?.message);
  if (!message) return res.status(400).json({ error: 'Please type a valid question.' });
  try {
    const history = Array.isArray(req.body?.history) ? req.body.history.filter(m => m && typeof m.content === 'string') : [];
    res.json({ reply: await chat({ documentText: 'General legal knowledge, contract terms, rental agreements, employment rights, consumer protection, NDAs, and legal clauses.', label: 'General Legal Assistant', history, message, lang: String(req.body?.lang || '') }) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/documents/:id', auth, (req, res) => {
  const db = load(); const i = db.documents.findIndex(x => x.id === req.params.id && x.uid === req.user.uid);
  if (i < 0) return res.status(404).json({ error: 'Document not found' });
  db.documents.splice(i, 1); save(db); res.json({ ok: true });
});

// ---- Privacy: delete ALL user data ----
app.delete('/api/user/data', auth, (req, res) => {
  const db = load();
  const before = db.documents.length;
  db.documents = db.documents.filter(d => d.uid !== req.user.uid);
  delete db.users[req.user.uid];
  save(db);
  res.json({ ok: true, deleted: before - db.documents.length });
});

// ---- Export: return structured data for client-side PDF generation ----
app.get('/api/documents/:id/export', auth, (req, res) => {
  const d = getDoc(req, res); if (!d) return;
  const a = d.analysis;
  res.json({
    label: a.label, name: d.name, type: a.type, uploadedAt: d.uploadedAt,
    riskScore: riskScore(a),
    summary: a.summary, simple: a.simple,
    risks: (a.risks || []).map(r => ({ title: r.title, severity: r.severity, advice: r.advice })),
    deadlines: (a.deadlines || []).map(x => ({ date: x.date, label: x.label, whatToSubmit: x.whatToSubmit, isDeadline: x.isDeadline, upcoming: x.upcoming })),
    actions: a.actions || [],
    wordCount: a.wordCount || 0,
  });
});

// ---- Email Reminders ----
function getEmailTransporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  if (host && user && pass) {
    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass }
    });
  }
  return null;
}

app.post('/api/reminders', auth, async (req, res) => {
  const { docId, date, label, whatToSubmit, email, daysBefore, sendImmediateTest } = req.body || {};
  const recipient = (email || req.user.email || '').trim();
  if (!recipient) return res.status(400).json({ error: 'Recipient email is required.' });
  if (!date) return res.status(400).json({ error: 'Deadline date is required.' });

  const db = load();
  db.reminders = db.reminders || [];
  const reminder = {
    id: crypto.randomUUID(),
    uid: req.user.uid,
    docId: docId || null,
    recipient,
    date,
    label: label || 'Upcoming Deadline',
    whatToSubmit: whatToSubmit || '-',
    daysBefore: parseInt(daysBefore, 10) || 3,
    createdAt: new Date().toISOString(),
    status: sendImmediateTest ? 'sent' : 'scheduled'
  };
  db.reminders.push(reminder);
  save(db);

  const transporter = getEmailTransporter();
  const subject = `⚖️ LegalLens Deadline Reminder: ${reminder.label} (${reminder.date})`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 1px solid #E9E2D8; border-radius: 12px; background: #ffffff;">
      <div style="border-bottom: 2px solid #6B2737; padding-bottom: 12px; margin-bottom: 20px;">
        <h2 style="color: #6B2737; margin: 0; font-size: 20px;">⚖️ LegalLens Deadline Reminder</h2>
      </div>
      <p style="color: #252323; font-size: 14px;">Hello <strong>${req.user.name || 'there'}</strong>,</p>
      <p style="color: #4A4644; font-size: 14px;">This is a reminder for an upcoming requirement from your legal documents:</p>
      <div style="background: #FAF7F2; border-left: 4px solid #6B2737; padding: 16px; margin: 18px 0; border-radius: 6px;">
        <p style="margin: 0 0 8px 0; font-size: 15px; color: #252323;"><strong>📅 Due Date:</strong> <span style="color: #B3372F; font-size: 17px; font-weight: 700;">${reminder.date}</span></p>
        <p style="margin: 0 0 8px 0; font-size: 14px; color: #252323;"><strong>📌 Item:</strong> ${reminder.label}</p>
        <p style="margin: 0; font-size: 14px; color: #252323;"><strong>📝 Requirement to submit:</strong> <span style="color: #6B2737; font-weight: 600;">${reminder.whatToSubmit}</span></p>
      </div>
      <p style="color: #706B67; font-size: 13px;">Please make sure all necessary steps are completed before the scheduled date.</p>
      <div style="margin-top: 24px; padding-top: 14px; border-top: 1px solid #E9E2D8; text-align: center; color: #8F8A85; font-size: 12px;">
        LegalLens · For informational purposes only, not legal advice.
      </div>
    </div>
  `;

  if (transporter && sendImmediateTest) {
    try {
      const from = process.env.SMTP_FROM || `"LegalLens Reminders" <${process.env.SMTP_USER}>`;
      await transporter.sendMail({ from, to: recipient, subject, html });
      return res.json({ ok: true, message: `Email reminder sent immediately to ${recipient}!` });
    } catch (err) {
      console.error('[SMTP error]', err);
      return res.json({ ok: true, message: `Reminder saved! (Notice: SMTP delivery failed: ${err.message})` });
    }
  }

  console.log(`[Reminder Scheduled] For: ${recipient}, Date: ${reminder.date}, Label: ${reminder.label}, WhatToSubmit: ${reminder.whatToSubmit}`);
  res.json({
    ok: true,
    message: sendImmediateTest
      ? `Email reminder sent to ${recipient}!`
      : `Email reminder scheduled for ${recipient}! (You will receive an alert before ${reminder.date})`
  });
});

// ---- Compare two documents ----
function simpleDiff(oldLines, newLines) {
  const changes = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const a = oldLines[i] ?? '';
    const b = newLines[i] ?? '';
    if (a === b) {
      if (a.trim()) changes.push({ type: 'same', text: a });
    } else {
      if (a.trim()) changes.push({ type: 'removed', text: a });
      if (b.trim()) changes.push({ type: 'added', text: b });
    }
  }
  return changes;
}

app.post('/api/documents/compare', auth, uploadLimiter, checkUploadConcurrency, (req, res, next) => {
  upload.fields([{ name: 'file1', maxCount: 1 }, { name: 'file2', maxCount: 1 }])(req, res, e => e ? res.status(400).json({ error: e.message }) : next());
}, async (req, res) => {
  const f1 = req.files?.file1?.[0], f2 = req.files?.file2?.[0];
  if (!f1 || !f2) return res.status(400).json({ error: 'Please upload two files to compare.' });

  // Validate binary signatures of both files
  const sig1 = validateFileSignature(f1.buffer, f1.originalname);
  if (!sig1.valid) return res.status(400).json({ error: `File 1 (${f1.originalname}): ${sig1.reason}` });
  const sig2 = validateFileSignature(f2.buffer, f2.originalname);
  if (!sig2.valid) return res.status(400).json({ error: `File 2 (${f2.originalname}): ${sig2.reason}` });

  try {
    const [text1, text2] = await Promise.all([extractTextFromFile(f1), extractTextFromFile(f2)]);
    const lines1 = text1.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
    const lines2 = text2.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
    const analysis1 = analyzeText(text1.replace(/\s+/g, ' ').trim().slice(0, 60000), f1.originalname);
    const analysis2 = analyzeText(text2.replace(/\s+/g, ' ').trim().slice(0, 60000), f2.originalname);
    const diff = simpleDiff(lines1, lines2);
    const added = diff.filter(d => d.type === 'added').length;
    const removed = diff.filter(d => d.type === 'removed').length;
    res.json({
      file1: f1.originalname, file2: f2.originalname,
      stats: { added, removed, unchanged: diff.filter(d => d.type === 'same').length },
      riskChange: { before: riskScore(analysis1), after: riskScore(analysis2) },
      newRisks: (analysis2.risks || []).filter(r2 => !(analysis1.risks || []).some(r1 => r1.title === r2.title)),
      removedRisks: (analysis1.risks || []).filter(r1 => !(analysis2.risks || []).some(r2 => r2.title === r1.title)),
      diff: diff.slice(0, 500),
    });
  } catch (e) { console.error('[compare error]', e); res.status(500).json({ error: 'Failed to compare files: ' + e.message }); }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) app.listen(PORT, () => console.log(`LegalLens running on http://localhost:${PORT}`));
module.exports = app;
