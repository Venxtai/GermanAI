const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const multer = require('multer');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const { google } = require('googleapis');
const fs = require('fs');

// Load unit display names from PDF-sourced mapping
let unitNames = {};
try {
  unitNames = JSON.parse(fs.readFileSync(path.join(__dirname, './unitNames.json'), 'utf8'));
  console.log(`Unit names loaded: ${Object.keys(unitNames).length} entries`);
} catch (e) {
  console.warn('unitNames.json not found — using fallback names');
}

// Load persona database
let personaDatabase = {};
try {
  const personaPath = path.join(__dirname, './personaDatabase.json');
  if (fs.existsSync(personaPath)) {
    const raw = JSON.parse(fs.readFileSync(personaPath, 'utf8'));
    // Strip the _comment meta key
    Object.entries(raw).forEach(([k, v]) => {
      if (!k.startsWith('_')) personaDatabase[k] = v;
    });
    console.log(`Persona database loaded: ${Object.keys(personaDatabase).length} chapters`);
  }
} catch (e) {
  console.warn('Persona database not found or invalid:', e.message);
}

// Load environment variables (override: true needed because some env vars may be set to empty)
dotenv.config({ override: true });

// Use VERBOSE instead of DEBUG to avoid triggering OpenAI SDK's HTTP header logging
const VERBOSE = process.env.VERBOSE === 'true';

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize API clients
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// Google service account credentials — works from file (local) or env var (Cloud Run)
// On Cloud Run, set GOOGLE_SERVICE_ACCOUNT_JSON env var with the full JSON content
let googleCredentials = null;
const credFilePath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS || './service-account.json');
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  // Cloud Run: credentials from environment variable
  googleCredentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  // Write to temp file for SDKs that need GOOGLE_APPLICATION_CREDENTIALS
  const tmpCredPath = path.join(require('os').tmpdir(), 'service-account.json');
  fs.writeFileSync(tmpCredPath, process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpCredPath;
  console.log('Using service account credentials from GOOGLE_SERVICE_ACCOUNT_JSON env var');
} else if (fs.existsSync(credFilePath)) {
  googleCredentials = JSON.parse(fs.readFileSync(credFilePath, 'utf8'));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credFilePath;
  console.log('Using service account credentials from file:', credFilePath);
} else {
  console.warn('WARNING: No service account credentials found. Google Sheets/Drive/TTS may not work.');
}

// Helper: create GoogleAuth with the right credentials for any scope
function createGoogleAuth(scopes) {
  if (googleCredentials) {
    return new google.auth.GoogleAuth({
      credentials: googleCredentials,
      scopes,
    });
  }
  return new google.auth.GoogleAuth({ scopes });
}

// Google Vertex AI
const googleAI = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT || 'sound-folder-471314-g5',
  location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '5mb' })); // Large limit needed for cumulative vocab data

// Configure multer for audio file uploads
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// ══════════════════════════════════════════════════════════════════════════
// ACCESS CODE SYSTEM — Google Sheets backend
// ══════════════════════════════════════════════════════════════════════════
const ACCESS_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || '1sN307djAoZ8k0qjzlYFJtiOfxC9c_HAJCXHYgpGul4w';

let sheetsClient = null;
async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const auth = createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets']);
  sheetsClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return sheetsClient;
}

// POST /api/auth/validate — Check access code, return validity + remaining uses
app.post('/api/auth/validate', async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ valid: false, error: 'No code provided' });
  }

  try {
    const sheets = await getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: ACCESS_SHEETS_ID,
      range: 'Access Codes!A2:I',
    });

    const rows = result.data.values || [];
    const codeLower = code.trim().toLowerCase();
    const rowIndex = rows.findIndex(r => (r[0] || '').toLowerCase() === codeLower);

    if (rowIndex === -1) {
      return res.json({ valid: false, error: 'Invalid access code' });
    }

    const row = rows[rowIndex];
    const type = row[1] || 'student';
    // A=Code, B=Type, C=Tool, D=Max Uses, E=Used, F=Created By, G=Assigned To, H=Email, I=Notes
    // Column C = Tool (Text, Buddy, or Both) — code is valid for Buddy if "Buddy" or "Both"
    const tool = (row[2] || '').trim().toLowerCase();
    if (tool !== 'buddy' && tool !== 'both') {
      return res.json({ valid: false, error: 'This access code is not valid for the Conversation Buddy' });
    }
    const maxUses = parseInt(row[3]) || 0;
    const used = parseInt(row[4]) || 0;
    const assignedTo = row[6] || '';

    if (used >= maxUses) {
      return res.json({ valid: false, error: 'Access code has expired (all uses consumed)', used, maxUses });
    }

    // Increment usage count (row is 0-indexed in data, +2 for header + 1-indexing)
    const sheetRow = rowIndex + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: ACCESS_SHEETS_ID,
      range: `Access Codes!E${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[used + 1]] },
    });

    // Log usage to Buddy Usage Log tab
    // Columns: Timestamp | Code | Type | Assigned To | Student Name | Unit | Session ID | Duration (min) | Transcript
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: ACCESS_SHEETS_ID,
      range: 'Buddy Usage Log!A:I',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[timestamp, code, type, assignedTo, '', '', '', '', '']],
      },
    });

    console.log(`[AUTH] Code "${code}" validated — ${used + 1}/${maxUses} uses (${type})`);

    return res.json({
      valid: true,
      type,
      remainingUses: maxUses - used - 1,
      assignedTo,
    });

  } catch (err) {
    console.error('[AUTH] Google Sheets error:', err.message);
    // If Sheets is down, allow access (fail-open for usability)
    return res.json({ valid: true, type: 'student', remainingUses: -1, error: 'Could not verify — access granted temporarily' });
  }
});

// POST /api/auth/log-session — Log completed session details to Buddy Usage Log
app.post('/api/auth/log-session', async (req, res) => {
  const { code, type, unit, sessionId, durationMin, studentName, assignedTo } = req.body;
  try {
    const sheets = await getSheetsClient();
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    // Columns: Timestamp | Code | Type | Assigned To | Student Name | Unit | Session ID | Duration (min) | Transcript
    await sheets.spreadsheets.values.append({
      spreadsheetId: ACCESS_SHEETS_ID,
      range: 'Buddy Usage Log!A:I',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[timestamp, code || '', type || '', assignedTo || '', studentName || '', unit || '', sessionId || '', durationMin || '', '']],
      },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[AUTH] Session log error:', err.message);
    res.json({ ok: false });
  }
});

// Impuls Deutsch 1 — chapters with titles and unit ranges
const ID1_CHAPTERS = [
  { chapter: 1, title: 'Wer bin ich?: Heute und in der Zukunft',                                     unitStart: 1,   unitEnd: 15  },
  { chapter: 2, title: 'Was ziehe ich an?: Wetter und Klimawandel',                                   unitStart: 16,  unitEnd: 26  },
  { chapter: 3, title: 'Was ist da drin? Lebensmittel unter der Lupe',                                unitStart: 27,  unitEnd: 37  },
  { chapter: 4, title: 'Wie gestalte ich mein Leben?: Schlanke Produktion f\u00fcr Haus und Alltag', unitStart: 38,  unitEnd: 52  },
  { chapter: 5, title: 'Woher kommen meine Sachen?: Konsum, Verpackungen, M\u00fclltrennung',         unitStart: 53,  unitEnd: 67  },
  { chapter: 6, title: 'Wie war es damals?: Kindheit im Wandel der Zeit',                            unitStart: 68,  unitEnd: 79  },
  { chapter: 7, title: "Was gibt's da zu sehen?: Sehensw\u00fcrdigkeiten in Wien",                    unitStart: 80,  unitEnd: 93  },
  { chapter: 8, title: 'Wie sieht die Zukunft aus?: Erfindungen und Innovationen',                   unitStart: 94,  unitEnd: 104 },
];

// Impuls Deutsch 2 BLAU
const ID2B_CHAPTERS = [
  { chapter: 1, title: 'Wie leben wir nachhaltig?: Kommunikation für die Zukunft unseres Planeten', unitStart: 1,  unitEnd: 14 },
  { chapter: 2, title: 'Was war da los?: Ost-West-Geschichte(n)',                                    unitStart: 15, unitEnd: 26 },
  { chapter: 3, title: 'Wer sind wir?: Deutsch im Plural',                                           unitStart: 27, unitEnd: 37 },
  { chapter: 4, title: 'Wie unterhalten wir uns?: Alte und neue Medien',                             unitStart: 38, unitEnd: 52 },
];

// Impuls Deutsch 2 ORANGE
const ID2O_CHAPTERS = [
  { chapter: 1, title: 'Wer würde sich trauen?: Achterbahnen und anderer Nervenkitzel',             unitStart: 1,  unitEnd: 17 },
  { chapter: 2, title: 'Wofür/wogegen sind wir?: Protest, Widerstand, Mitbestimmung',               unitStart: 18, unitEnd: 29 },
  { chapter: 3, title: 'Wie wird das gemacht?: Die Schweiz als Herstellerin von Qualitätsprodukten', unitStart: 30, unitEnd: 41 },
  { chapter: 4, title: 'Was prägt uns?: Transatlantische Beziehungen und Einflüsse',                unitStart: 42, unitEnd: 52 },
];

const ALL_CHAPTERS = { ID1: ID1_CHAPTERS, ID2B: ID2B_CHAPTERS, ID2O: ID2O_CHAPTERS };

function getChapter(unitNum) {
  const n = parseInt(unitNum);
  return ID1_CHAPTERS.find(c => n >= c.unitStart && n <= c.unitEnd) || null;
}

/**
 * Get the previous chapter, crossing book boundaries if needed.
 * Returns { meta: chapterObj, book: 'ID1'|'ID2B'|'ID2O' } or null.
 */
function getPreviousChapter(book, currentChapterMeta) {
  const bookChapters = ALL_CHAPTERS[book] || ID1_CHAPTERS;
  const currentIdx = bookChapters.findIndex(ch => ch.chapter === currentChapterMeta.chapter);
  if (currentIdx > 0) return { meta: bookChapters[currentIdx - 1], book };
  // First chapter of ID2B or ID2O → go back to ID1 last chapter
  if ((book === 'ID2B' || book === 'ID2O') && currentIdx === 0) {
    return { meta: ID1_CHAPTERS[ID1_CHAPTERS.length - 1], book: 'ID1' };
  }
  return null; // ID1 Ch1 has no previous
}

/**
 * Get all unit IDs belonging to a chapter in a given book.
 */
function getChapterUnitIds(chapterMeta, chBook, unitMapRef) {
  const ids = [];
  for (let pos = chapterMeta.unitStart; pos <= chapterMeta.unitEnd; pos++) {
    let uid;
    if (chBook === 'ID1') uid = String(pos);
    else if (chBook === 'ID2B') uid = `B${String(pos).padStart(2, '0')}`;
    else if (chBook === 'ID2O') uid = `O${String(pos).padStart(2, '0')}`;
    else uid = String(pos);
    if (unitMapRef[uid]) ids.push(uid);
  }
  return ids;
}

/**
 * Collect unique conversation topics from a list of unit IDs.
 */
function collectTopicsFromUnits(unitIds, unitMapRef) {
  const topics = [];
  for (const uid of unitIds) {
    const u = unitMapRef[uid];
    if (u) {
      for (const t of (u.conversation_topics?.topics || [])) {
        if (t && !topics.includes(t)) topics.push(t);
      }
    }
  }
  return topics;
}

// Load all unit files from Knowledge Base folder
const unitMap = {};
try {
  const kbDir = path.join(__dirname, '../curriculum/units/Knowledge Base');
  if (fs.existsSync(kbDir)) {
    const files = fs.readdirSync(kbDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(kbDir, file), 'utf8'));
        if (data.unit !== undefined) {
          unitMap[String(data.unit)] = data;
        }
      } catch (e) {
        console.warn(`Skipping ${file}: ${e.message}`);
      }
    }
    console.log(`Loaded ${Object.keys(unitMap).length} units from Knowledge Base`);
  } else {
    console.warn('Knowledge Base directory not found:', kbDir);
  }
} catch (error) {
  console.error('Error loading curriculum data:', error);
}

// Load universal fillers from unit 1 (same for all units — loaded once at startup)
const UNIVERSAL_FILLERS = unitMap['1']?.universal_fillers || {};
const UNIVERSAL_FILLER_WORDS = new Set();
for (const category of Object.values(UNIVERSAL_FILLERS)) {
  if (Array.isArray(category)) {
    for (const filler of category) {
      for (const word of filler.toLowerCase().replace(/[.,!?]/g, '').split(/\s+/)) {
        if (word.length > 0) UNIVERSAL_FILLER_WORDS.add(word);
      }
    }
  }
}
console.log(`Loaded ${UNIVERSAL_FILLER_WORDS.size} universal filler words`);

// Initialize Google Drive client for transcript uploads
let driveClient = null;
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '1QBFSdzunA5GRIuflyf0gVqxA7gLKF_5M';
try {
  if (googleCredentials) {
    const auth = createGoogleAuth(['https://www.googleapis.com/auth/drive']);
    driveClient = google.drive({ version: 'v3', auth });
    console.log('Google Drive client initialized for transcript uploads');
  } else {
    console.warn('No credentials — transcripts will save locally only');
  }
} catch (e) {
  console.warn('Google Drive init failed:', e.message, '— transcripts will save locally only');
}

// Load image map data
let imageMap = {};
try {
  const imageMapPath = path.join(__dirname, './imageMap.json');
  if (fs.existsSync(imageMapPath)) {
    imageMap = JSON.parse(fs.readFileSync(imageMapPath, 'utf8')).imageMap || {};
  }
} catch (error) {
  console.error('Error loading image map:', error);
}

// Store active conversations (in production, use a database)
const conversations = new Map();

// Voice pipeline sessions — stores conversation history + system prompt per session
const voiceSessions = new Map();

// ─── SSE log broadcast ─────────────────────────────────────────────────────
const logClients = new Set();
const logHistory = []; // persists all events for replay on reconnect
const MAX_HISTORY = 500;

function broadcastLog(payload) {
  logHistory.push(payload);
  if (logHistory.length > MAX_HISTORY) logHistory.shift();
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of logClients) {
    try { res.write(data); } catch (_) { logClients.delete(res); }
  }
}
// ─── Conversation Logger ────────────────────────────────────────────────────
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const CYAN   = '\x1b[36m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA= '\x1b[35m';
const RED    = '\x1b[31m';
const BLUE   = '\x1b[34m';

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function logConversationStart(sessionId, unitNumber) {
  const unitData = unitMap[String(unitNumber)];
  const unitLabel = unitData
    ? `Unit ${unitNumber} — ${unitNames[String(unitNumber)] || (unitData.conversation_topics?.topics || [])[0] || ''}`
    : `Unit ${unitNumber}`;
  console.log(`\n${BOLD}${CYAN}${'═'.repeat(60)}${RESET}`);
  console.log(`${BOLD}${GREEN}[${timestamp()}] CONVERSATION STARTED${RESET}`);
  console.log(`${DIM}Session : ${sessionId}${RESET}`);
  console.log(`${DIM}Unit    : ${unitLabel}${RESET}`);
  console.log(`${BOLD}${CYAN}${'─'.repeat(60)}${RESET}`);
  broadcastLog({ type: 'start', sessionId, unitLabel, time: timestamp() });
}

function logTurn(role, text) {
  const time = `${DIM}[${timestamp()}]${RESET}`;
  if (role === 'student') {
    console.log(`${time} ${BOLD}${YELLOW}STUDENT:${RESET} ${text}`);
  } else {
    console.log(`${time} ${BOLD}${BLUE} BUDDY :${RESET} ${text}`);
  }
  // NOTE: does NOT call broadcastLog — callers handle that themselves.
}

function logConversationEnd(sessionId, exchangeCount) {
  console.log(`${BOLD}${CYAN}${'─'.repeat(60)}${RESET}`);
  console.log(`${BOLD}${RED}[${timestamp()}] CONVERSATION ENDED${RESET}  ${DIM}session: ${sessionId} | ${exchangeCount} student turn(s)${RESET}`);
  console.log(`${BOLD}${CYAN}${'═'.repeat(60)}${RESET}\n`);
  broadcastLog({ type: 'end', sessionId, exchangeCount, time: timestamp() });
}

/**
 * Save a transcript as a .txt file to Google Drive (with local fallback).
 * Filename: Unit_XXX_YYYY-MM-DD_HHMMSS_sessionId.txt
 * Sorted alphabetically: same unit together, then by date.
 */
async function saveTranscriptFile(sessionId, logSession) {
  try {
    const unit = logSession.unit || 'unknown';
    const unitTitle = logSession.unitTitle || '';
    const unitPadded = String(unit).padStart(3, '0');

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');

    const filename = `Unit_${unitPadded}_${dateStr}_${timeStr}_${sessionId}.txt`;

    // Build transcript text
    const lines = [];
    lines.push('═'.repeat(60));
    lines.push(`CONVERSATION TRANSCRIPT`);
    lines.push(`Unit    : Unit ${unit} — ${unitTitle}`);
    lines.push(`Date    : ${now.toLocaleString()}`);
    lines.push(`Session : ${sessionId}`);
    lines.push(`Turns   : ${logSession.exchangeCount} student turn(s)`);
    lines.push('─'.repeat(60));
    lines.push('');

    for (const turn of (logSession.turns || [])) {
      const speaker = turn.role === 'student' ? 'STUDENT' : ' BUDDY';
      lines.push(`[${turn.time}] ${speaker}: ${turn.text}`);
    }

    lines.push('');
    lines.push('─'.repeat(60));
    lines.push(`[${timestamp()}] CONVERSATION ENDED`);
    lines.push('═'.repeat(60));

    const content = lines.join('\n');

    // Upload to Google Drive
    if (driveClient) {
      try {
        const { Readable } = require('stream');
        const stream = Readable.from([content]);
        const driveRes = await driveClient.files.create({
          supportsAllDrives: true,
          requestBody: {
            name: filename,
            mimeType: 'text/plain',
            parents: [DRIVE_FOLDER_ID],
          },
          media: {
            mimeType: 'text/plain',
            body: stream,
          },
          fields: 'id',
        });
        const fileId = driveRes.data.id;
        const driveLink = `https://drive.google.com/file/d/${fileId}/view`;
        console.log(`${DIM}[TRANSCRIPT] Uploaded to Google Drive: ${filename}${RESET}`);

        // Append transcript link to the last row of Buddy Usage Log (column I)
        try {
          const sheets = await getSheetsClient();
          // Find the last row with this session ID
          const logData = await sheets.spreadsheets.values.get({
            spreadsheetId: ACCESS_SHEETS_ID,
            range: 'Buddy Usage Log!G:G',
          });
          const rows = logData.data.values || [];
          let targetRow = -1;
          for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i][0] === sessionId) { targetRow = i + 1; break; }
          }
          if (targetRow > 0) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: ACCESS_SHEETS_ID,
              range: `Buddy Usage Log!I${targetRow}`,
              valueInputOption: 'USER_ENTERED',
              requestBody: { values: [[`=HYPERLINK("${driveLink}","open")`]] },
            });
          }
        } catch (sheetErr) {
          console.warn('[TRANSCRIPT] Could not add Drive link to Buddy Usage Log:', sheetErr.message);
        }
      } catch (driveErr) {
        console.error('[TRANSCRIPT] Drive upload failed:', driveErr.message, '— saving locally');
        saveTranscriptLocally(filename, content);
      }
    } else {
      saveTranscriptLocally(filename, content);
    }
  } catch (err) {
    console.error('[TRANSCRIPT] Failed to save:', err.message);
  }
}

function saveTranscriptLocally(filename, content) {
  const transcriptsDir = path.join(__dirname, '../transcripts');
  if (!fs.existsSync(transcriptsDir)) fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptsDir, filename), content, 'utf8');
  console.log(`${DIM}[TRANSCRIPT] Saved locally: transcripts/${filename}${RESET}`);
}

// ────────────────────────────────────────────────────────────────────────────

/**
 * Helper function to find matching image from imageMap based on unit and response text
 */
function getImageForResponse(unitNumber, responseText) {
  const unitImages = imageMap[String(unitNumber)];
  if (!unitImages) return null;
  
  const responseTextLower = responseText.toLowerCase();
  
  for (const imageConfig of (unitImages.images || [])) {
    for (const keyword of (imageConfig.keywords || [])) {
      if (responseTextLower.includes(keyword.toLowerCase())) {
        return {
          path: imageConfig.path,
          duration: imageConfig.duration,
          description: imageConfig.description
        };
      }
    }
  }
  
  return null;
}

/**
 * Route: Chapter list for Book ID1
 */
app.get('/api/chapters', (req, res) => {
  const book = req.query.book || 'ID1';
  res.json(ALL_CHAPTERS[book] || ID1_CHAPTERS);
});

/**
 * Route: Lightweight unit index — filtered by ?book=X&chapter=N
 */
app.get('/api/units', (req, res) => {
  const book = req.query.book || 'ID1';
  const chapter = req.query.chapter ? parseInt(req.query.chapter) : null;
  const chapterList = ALL_CHAPTERS[book] || ID1_CHAPTERS;
  const chMeta = chapter ? chapterList.find(c => c.chapter === chapter) : null;

  // Filter units belonging to the requested book
  let units = Object.values(unitMap).filter(u => {
    const uid = String(u.unit);
    if (book === 'ID1')  return !uid.startsWith('B') && !uid.startsWith('O');
    if (book === 'ID2B') return uid.startsWith('B');
    if (book === 'ID2O') return uid.startsWith('O');
    return false;
  });

  // Further filter by chapter range using sequence_info.position
  if (chMeta) {
    units = units.filter(u => {
      const pos = u.sequence_info?.position
        || parseInt(String(u.unit).replace(/^[BO]/i, ''));
      return pos >= chMeta.unitStart && pos <= chMeta.unitEnd;
    });
  }

  const index = units
    .map(u => ({
      unit: u.unit,
      position: u.sequence_info?.position
        || parseInt(String(u.unit).replace(/^[BO]/i, '')),
      is_optional: u.is_optional || false,
      topic: unitNames[String(u.unit)]
          || (u.communicative_functions?.goals || [])[0]
          || (u.conversation_topics?.topics || [])[0]
          || `Unit ${u.unit}`,
    }))
    .sort((a, b) => a.position - b.position);

  res.json(index);
});

/**
 * Route: Full unit data for a single unit
 */
app.get('/api/units/:unitId', (req, res) => {
  const unit = unitMap[req.params.unitId];
  if (!unit) {
    return res.status(404).json({ error: `Unit ${req.params.unitId} not found` });
  }
  res.json(unit);
});

/**
 * Route: Cumulative unit data for conversation buddy.
 * Merges active/passive vocabulary, verb forms, conversation topics, and
 * communicative functions from ALL non-optional prerequisite units.
 * Grammar constraints come from the CURRENT unit only.
 * Query: ?book=ID1|ID2B|ID2O (default: ID1)
 */
app.get('/api/cumulative/:unitId', (req, res) => {
  const targetId = req.params.unitId;
  const book = req.query.book || 'ID1';
  const targetUnit = unitMap[targetId];
  if (!targetUnit) return res.status(404).json({ error: `Unit ${targetId} not found` });

  // Build ordered prerequisite list
  const prerequisiteIds = [];
  if (book === 'ID1') {
    const targetNum = parseInt(targetId);
    for (let i = 1; i <= targetNum; i++) { if (unitMap[String(i)]) prerequisiteIds.push(String(i)); }
  } else if (book === 'ID2B') {
    for (let i = 1; i <= 104; i++) { if (unitMap[String(i)]) prerequisiteIds.push(String(i)); }
    const targetNum = parseInt(targetId.replace(/^B/i, ''));
    for (let i = 1; i <= targetNum; i++) { const bid = `B${String(i).padStart(2,'0')}`; if (unitMap[bid]) prerequisiteIds.push(bid); }
  } else if (book === 'ID2O') {
    for (let i = 1; i <= 104; i++) { if (unitMap[String(i)]) prerequisiteIds.push(String(i)); }
    const targetNum = parseInt(targetId.replace(/^O/i, ''));
    for (let i = 1; i <= targetNum; i++) { const oid = `O${String(i).padStart(2,'0')}`; if (unitMap[oid]) prerequisiteIds.push(oid); }
  }

  // ── Cumulative vocabulary collection ──
  const cumulativeActiveVocab = [], cumulativePassiveVocab = [];
  const cumulativeVerbForms = {};
  const seenActive = new Set(), seenPassive = new Set();

  for (const uid of prerequisiteIds) {
    const u = unitMap[uid];
    if (!u) continue;
    if (u.is_optional) continue;

    for (const item of (u.active_vocabulary?.items || [])) {
      const word = typeof item === 'object' ? item.word : item;
      if (word && !seenActive.has(word)) { seenActive.add(word); cumulativeActiveVocab.push(typeof item === 'object' ? item : { word: item }); }
    }
    for (const item of (u.passive_vocabulary?.items || [])) {
      const word = typeof item === 'object' ? item.word : item;
      if (word && !seenPassive.has(word)) { seenPassive.add(word); cumulativePassiveVocab.push(typeof item === 'object' ? item : { word: item }); }
    }
    const verbs = u.allowed_verb_forms?.verbs || {};
    for (const [verb, tenses] of Object.entries(verbs)) {
      if (!cumulativeVerbForms[verb]) cumulativeVerbForms[verb] = {};
      for (const [tense, persons] of Object.entries(tenses)) {
        if (!cumulativeVerbForms[verb][tense]) cumulativeVerbForms[verb][tense] = {};
        Object.assign(cumulativeVerbForms[verb][tense], persons);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // TOPIC ORGANIZATION — "Last 10 units" proximity model
  // ══════════════════════════════════════════════════════════════

  const targetPos = targetUnit.sequence_info?.position || parseInt(String(targetId).replace(/^[BO]/i, ''));
  const chapterList = ALL_CHAPTERS[book] || ID1_CHAPTERS;
  const currentChapterMeta = chapterList.find(ch => targetPos >= ch.unitStart && targetPos <= ch.unitEnd);
  const currentChapterNum = currentChapterMeta?.chapter || 1;

  // ── Build ordered list of all non-optional prerequisite unit IDs (including target) ──
  const allCoveredIds = [...prerequisiteIds.filter(uid => {
    const u = unitMap[uid];
    return u && !u.is_optional;
  })];
  // Add target if not already included
  if (!allCoveredIds.includes(targetId) && unitMap[targetId]) {
    allCoveredIds.push(targetId);
  }

  // Warm-up topics to exclude from conversation topic pools (they belong in Phase 1 only)
  const WARMUP_STARTER_TOPICS = [
    'der eigene name', 'namen', 'herkunft, wohnort und studium',
    'begrüßung', 'verabschiedung', 'sich vorstellen',
  ];
  function filterWarmupTopics(topics) {
    return topics.filter(t => !WARMUP_STARTER_TOPICS.some(wt => t.toLowerCase().includes(wt)));
  }

  // ── MAIN BLOCK: last 10 units (60%) ──
  // Slice the last 10 covered units — this is the "recent" pool
  const last10 = allCoveredIds.slice(-10);
  const currentUnitTopics = filterWarmupTopics(targetUnit.conversation_topics?.topics || []);

  // Subdivide: last 4 (close), units 5-8 (middle), units 9-10 (far)
  const last4Ids  = last10.slice(-4);   // most recent 4 (includes current)
  const mid4Ids   = last10.slice(-8, -4); // units 5-8 back
  const far2Ids   = last10.slice(0, Math.max(0, last10.length - 8)); // remainder up to 10

  const last10Tiers = [
    { label: `Last 4 units (${last4Ids[0] || '?'}–${last4Ids[last4Ids.length - 1] || '?'})`, topics: filterWarmupTopics(collectTopicsFromUnits(last4Ids, unitMap)), units: last4Ids },
    { label: `Units 5–8 back (${mid4Ids[0] || '?'}–${mid4Ids[mid4Ids.length - 1] || '?'})`, topics: filterWarmupTopics(collectTopicsFromUnits(mid4Ids, unitMap)), units: mid4Ids },
    { label: `Units 9–10 back (${far2Ids[0] || '?'}–${far2Ids[far2Ids.length - 1] || '?'})`, topics: filterWarmupTopics(collectTopicsFromUnits(far2Ids, unitMap)), units: far2Ids },
  ].filter(t => t.units.length > 0);

  // ── REVIEW BLOCK: all units in current chapter + previous chapter, minus the last 10 (40%) ──
  const last10Set = new Set(last10);

  // Current chapter units NOT in the last 10
  const currentChapterReviewIds = [];
  if (currentChapterMeta) {
    for (let pos = currentChapterMeta.unitStart; pos <= targetPos; pos++) {
      let uid;
      if (book === 'ID1') uid = String(pos);
      else if (book === 'ID2B') uid = `B${String(pos).padStart(2, '0')}`;
      else if (book === 'ID2O') uid = `O${String(pos).padStart(2, '0')}`;
      else uid = String(pos);
      const u = unitMap[uid];
      if (u && !u.is_optional && !last10Set.has(uid)) currentChapterReviewIds.push(uid);
    }
  }

  // Previous chapter units NOT in the last 10
  const prevChInfo = currentChapterMeta ? getPreviousChapter(book, currentChapterMeta) : null;
  let previousChapterReviewIds = [];
  let previousChapterLabel = '';
  let previousChapterGrammar = null;
  if (prevChInfo) {
    const prevUnitIds = getChapterUnitIds(prevChInfo.meta, prevChInfo.book, unitMap);
    previousChapterReviewIds = prevUnitIds.filter(uid => {
      const u = unitMap[uid];
      return u && !u.is_optional && !last10Set.has(uid);
    });
    previousChapterLabel = `Chapter ${prevChInfo.meta.chapter}: ${prevChInfo.meta.title}`;
    const lastPrevUnit = unitMap[prevUnitIds[prevUnitIds.length - 1]];
    previousChapterGrammar = lastPrevUnit?.grammar_constraints ? {
      allowed_tenses: lastPrevUnit.grammar_constraints.allowed_tenses || ['present'],
      allowed_cases: lastPrevUnit.grammar_constraints.allowed_cases || ['nominative'],
    } : null;
  }

  const reviewUnitIds = [...currentChapterReviewIds, ...previousChapterReviewIds];
  const reviewTopicsRaw = collectTopicsFromUnits(reviewUnitIds, unitMap);

  // Filter out warm-up starter topics — they belong in Phase 1, not Phase 2 review
  const reviewTopicsAll = filterWarmupTopics(reviewTopicsRaw);

  // Fallback chapters (further back, only if review pool is exhausted)
  const fallbackChapters = [];
  let lookbackRef = prevChInfo;
  for (let i = 0; i < 3 && lookbackRef; i++) {
    lookbackRef = getPreviousChapter(lookbackRef.book, lookbackRef.meta);
    if (lookbackRef) {
      const fbUnitIds = getChapterUnitIds(lookbackRef.meta, lookbackRef.book, unitMap);
      fallbackChapters.push({
        label: `Chapter ${lookbackRef.meta.chapter}: ${lookbackRef.meta.title}`,
        book: lookbackRef.book,
        topics: collectTopicsFromUnits(fbUnitIds, unitMap).slice(0, 8),
      });
    }
  }

  // Grammar info: new rules from the last 4 units
  const recentNewGrammar = [];
  for (const uid of last4Ids) {
    const u = unitMap[uid];
    if (u?.grammar_constraints?.new_rules_in_this_unit) {
      for (const rule of u.grammar_constraints.new_rules_in_this_unit) {
        if (!recentNewGrammar.includes(rule)) recentNewGrammar.push(rule);
      }
    }
  }

  // Legacy reviewTopics for ConversationManager
  const legacyReviewTopics = reviewTopicsAll.map(t => ({ chapter: previousChapterLabel || 'Review', topic: t }));

  res.json({
    ...targetUnit,
    _cumulative: {
      activeVocabulary: cumulativeActiveVocab,
      passiveVocabulary: cumulativePassiveVocab,
      verbForms: cumulativeVerbForms,
      // Main block: last 10 units by proximity tiers
      last10Tiers,
      currentUnitTopics,
      // Review block: remaining units in current + previous chapter
      reviewData: {
        topics: reviewTopicsAll,
        currentChapterExtras: collectTopicsFromUnits(currentChapterReviewIds, unitMap),
        previousChapter: previousChapterReviewIds.length > 0 ? {
          label: previousChapterLabel,
          topics: collectTopicsFromUnits(previousChapterReviewIds, unitMap),
          grammarSummary: previousChapterGrammar,
        } : null,
      },
      fallbackChapters,
      recentNewGrammar,
      chapterNumber: currentChapterNum,
      // Legacy format for ConversationManager
      reviewTopics: legacyReviewTopics,
      stats: {
        totalActiveWords: cumulativeActiveVocab.length,
        totalPassiveWords: cumulativePassiveVocab.length,
        totalVerbs: Object.keys(cumulativeVerbForms).length,
        totalReviewTopics: legacyReviewTopics.length,
        prerequisiteUnits: prerequisiteIds.length,
        last10Units: last10.length,
      },
    },
  });
});

// (Removed: /api/conversation/start — replaced by /api/session/start pipeline)

// (Removed: /api/speech-to-text, /api/conversation/message, /api/text-to-speech — replaced by pipeline)

// Cache for one-off TTS results (keyed by text hash) — avoids re-generating the same audio
const ttsCache = new Map();
const WELCOME_INSTRUCTIONS_TEXT = `Welcome to the Impuls Deutsch Conversation Buddy! Here are a few tips before we start. Speak only in German during the conversation. If you don't understand something, say "Wie bitte?" or "Noch einmal, bitte." Answer the buddy's questions, but also ask your own questions! Pay attention to the buddy's answers — you may need them later. A progress bar will show how much conversation time remains before you receive feedback. When you're ready, click the button below to begin.`;

// POST /api/tts — One-off TTS for non-conversation audio (e.g., welcome instructions)
// Uses Gemini 2.5 Pro TTS with configurable voice. Falls back to OpenAI. Caches results.
app.post('/api/tts', async (req, res) => {
  let { text, voice = 'Schedar', language = 'en-US' } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  // __WELCOME__ is a shortcut for the pre-cached welcome audio
  if (text === '__WELCOME__') {
    const welcomeKey = `Schedar:en-US:${WELCOME_INSTRUCTIONS_TEXT}`;
    if (ttsCache.has(welcomeKey)) {
      return res.json(ttsCache.get(welcomeKey));
    }
    // Not cached yet — use the actual text
    text = WELCOME_INSTRUCTIONS_TEXT;
  }

  // Check cache first
  const cacheKey = `${voice}:${language}:${text}`;
  if (ttsCache.has(cacheKey)) {
    return res.json(ttsCache.get(cacheKey));
  }

  try {
    // Use Gemini Vertex AI TTS
    const response = await googleAI.models.generateContent({
      model: 'gemini-2.5-pro-tts',
      contents: [{ role: 'user', parts: [{ text: `Say this in American English. Pronounce any German words or phrases naturally in German with a native German accent. Here is the text: ${text}` }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
          languageCode: language,
        },
      },
    });
    const audioPart = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!audioPart?.data) throw new Error('No audio in Gemini response');

    const rawMime = audioPart.mimeType || '';
    let result;
    if (rawMime.includes('L16') || rawMime.includes('pcm')) {
      const rateMatch = rawMime.match(/rate=(\d+)/);
      const sampleRate = rateMatch ? parseInt(rateMatch[1]) : 24000;
      const pcmBuffer = Buffer.from(audioPart.data, 'base64');
      const wavBuffer = wrapPcmInWav(pcmBuffer, sampleRate);
      result = { audioBase64: wavBuffer.toString('base64'), mimeType: 'audio/wav' };
    } else {
      result = { audioBase64: audioPart.data, mimeType: rawMime };
    }
    ttsCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[TTS] Gemini one-off TTS error:', err.message, '— falling back to OpenAI');
    try {
      const mp3 = await openai.audio.speech.create({
        model: 'tts-1', voice: 'echo', input: text, speed: 1.0, response_format: 'mp3',
      });
      const buffer = Buffer.from(await mp3.arrayBuffer());
      const fallbackResult = { audioBase64: buffer.toString('base64'), mimeType: 'audio/mpeg' };
      ttsCache.set(cacheKey, fallbackResult);
      res.json(fallbackResult);
    } catch (fallbackErr) {
      console.error('[TTS] OpenAI fallback also failed:', fallbackErr.message);
      res.status(500).json({ error: 'TTS failed' });
    }
  }
});

// SSE stream endpoint — log viewer connects here
app.get('/log-stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.flushHeaders();

  // Replay full history so reconnecting clients see everything
  for (const payload of logHistory) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  logClients.add(res);
  req.on('close', () => logClients.delete(res));
});

// Log viewer page
app.get('/log-viewer', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Conversation Log — Live</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d0d0d; color: #e2e8f0; font-family: 'Consolas', 'Menlo', monospace; font-size: 13.5px; padding: 20px; }
  #header { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; border-bottom: 1px solid #2d2d2d; padding-bottom: 14px; }
  #header h1 { font-size: 15px; font-weight: 600; color: #94a3b8; letter-spacing: .04em; }
  #dot { width: 9px; height: 9px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 6px #22c55e; animation: pulse 1.5s infinite; }
  #dot.off { background: #6b7280; box-shadow: none; animation: none; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  #log { display: flex; flex-direction: column; gap: 4px; }
  .sep { border-top: 1px solid #2a2a2a; margin: 10px 0; }
  .sep-heavy { border-top: 2px solid #334155; margin: 12px 0; }
  .row { display: flex; gap: 10px; line-height: 1.55; }
  .time { color: #475569; min-width: 74px; flex-shrink: 0; }
  .label { font-weight: 700; min-width: 68px; flex-shrink: 0; }
  .label.student { color: #fbbf24; }
  .label.ai      { color: #60a5fa; }
  .label.system  { color: #34d399; }
  .label.end     { color: #f87171; }
  .text { color: #e2e8f0; white-space: pre-wrap; word-break: break-word; }
  .text.pending { color: #475569; font-style: italic; }
  .meta { color: #64748b; font-size: 12px; }
  #empty { color: #475569; margin-top: 30px; text-align: center; }
</style>
</head>
<body>
<div id="header">
  <div id="dot"></div>
  <h1>Conversation Log &mdash; Live</h1>
</div>
<div id="log"><p id="empty">Waiting for a conversation to start…</p></div>
<script>
  const log = document.getElementById('log');
  const dot = document.getElementById('dot');
  let hasContent = false;

  function addRow(html) {
    const empty = document.getElementById('empty');
    if (empty) empty.remove();
    if (!hasContent) hasContent = true;
    log.insertAdjacentHTML('beforeend', html);
    window.scrollTo(0, document.body.scrollHeight);
  }

  const es = new EventSource('/log-stream');
  dot.className = '';

  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'start') {
      // Clear the log display for the new session
      log.innerHTML = '';
      hasContent = false;
      addRow('<div class="sep-heavy"></div>');
      addRow('<div class="row"><span class="time">' + ev.time + '</span><span class="label system">SESSION</span><span class="text">' + escHtml(ev.unitLabel) + '</span></div>');
      addRow('<div class="sep"></div>');
    } else if (ev.type === 'turn') {
      const cls = ev.role === 'student' ? 'student' : 'ai';
      const lbl = ev.role === 'student' ? 'STUDENT' : ' BUDDY';
      const idAttr = ev.id ? ' data-turn-id="' + escHtml(ev.id) + '"' : '';
      const textCls = ev.pending ? 'text pending' : 'text';
      addRow('<div class="row"' + idAttr + '><span class="time">' + ev.time + '</span><span class="label ' + cls + '">' + lbl + '</span><span class="' + textCls + '">' + escHtml(ev.text) + '</span></div>');
    } else if (ev.type === 'update-turn') {
      // Replace the placeholder text with the real transcription
      const row = document.querySelector('[data-turn-id="' + ev.id + '"]');
      if (row) {
        const span = row.querySelector('.text');
        if (span) { span.textContent = ev.text; span.classList.remove('pending'); }
      }
    } else if (ev.type === 'end') {
      addRow('<div class="sep"></div>');
      addRow('<div class="row"><span class="time">' + ev.time + '</span><span class="label end">ENDED &nbsp;</span><span class="meta">' + ev.exchangeCount + ' student turn(s)</span></div>');
      addRow('<div class="sep-heavy"></div>');
    }
  };

  es.onerror = () => { dot.className = 'off'; };
  es.onopen  = () => { dot.className = ''; };

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
<\/script>
</body>
</html>`);
});

/**
 * Route: Conversation logger — frontend posts transcripts here.
 * body: { type: 'start'|'turn'|'end', sessionId, unit?, unitTitle?, role?: 'student'|'ai', text? }
 */
const logSessions = new Map(); // sessionId → { unit, unitTitle, exchangeCount }

app.post('/api/log', (req, res) => {
  const { type, sessionId, unit, unitTitle, role, text } = req.body;

  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  if (type === 'start') {
    // Clear history so reconnecting clients only see the current session
    logHistory.length = 0;
    logSessions.set(sessionId, { unit, unitTitle, exchangeCount: 0, turns: [], startTime: timestamp() });
    const label = unitTitle ? `Unit ${unit} — ${unitTitle}` : `Unit ${unit}`;
    console.log(`\n${BOLD}${CYAN}${'═'.repeat(60)}${RESET}`);
    console.log(`${BOLD}${GREEN}[${timestamp()}] CONVERSATION STARTED${RESET}`);
    console.log(`${DIM}Session : ${sessionId}${RESET}`);
    console.log(`${DIM}Unit    : ${label}${RESET}`);
    console.log(`${BOLD}${CYAN}${'─'.repeat(60)}${RESET}`);
    broadcastLog({ type: 'start', sessionId, unitLabel: label, time: timestamp() });

  } else if (type === 'turn') {
    const session = logSessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (role === 'student') session.exchangeCount++;
    const { id, pending } = req.body;
    // For pending student placeholders, skip the console until the real text arrives
    if (!pending) {
      logTurn(role, text);
      session.turns.push({ role, text, time: timestamp() });
    }
    broadcastLog({ type: 'turn', role, text, id: id || null, pending: !!pending, time: timestamp() });

  } else if (type === 'update-turn') {
    // Whisper transcription arrived — update the placeholder row in the log.
    const { id, text: updatedText } = req.body;
    // Mutate the logHistory entry so replaying clients get the final text
    for (let i = logHistory.length - 1; i >= 0; i--) {
      if (logHistory[i].id === id) {
        logHistory[i].text = updatedText;
        logHistory[i].pending = false;
        break;
      }
    }
    logTurn('student', updatedText);
    // Find the session and update/add the turn with real text
    for (const [, sess] of logSessions) {
      // Replace last student placeholder or add new
      const lastStudent = [...sess.turns].reverse().find(t => t.role === 'student');
      if (lastStudent && lastStudent.text === '...') {
        lastStudent.text = updatedText;
      }
    }
    broadcastLog({ type: 'update-turn', id, text: updatedText, time: timestamp() });

  } else if (type === 'end') {
    const session = logSessions.get(sessionId);
    const count = session ? session.exchangeCount : 0;
    logConversationEnd(sessionId, count);

    // Save transcript to file
    if (session) {
      saveTranscriptFile(sessionId, session);
    }

    logSessions.delete(sessionId);
  }

  res.json({ ok: true });
});

// (Removed: /api/conversation/end — replaced by voice pipeline session management)

// Cleanup old conversations and voice sessions (every hour)
setInterval(() => {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1 hour

  for (const [id, conversation] of conversations.entries()) {
    if (now - conversation.createdAt > maxAge) {
      logConversationEnd(id, conversation.exchangeCount || 0);
      conversations.delete(id);
    }
  }
  for (const [id, session] of voiceSessions.entries()) {
    if (now - session.startTime > maxAge) {
      voiceSessions.delete(id);
    }
  }
}, 60 * 60 * 1000);

// ─── Voice Pipeline Endpoints ────────────────────────────────────────────────

/**
 * Helper: Wrap raw PCM16 audio data in a WAV header.
 * Gemini TTS returns raw linear PCM — browsers need a proper WAV file to decode.
 */
function wrapPcmInWav(pcmBuffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);                           // ChunkID
  header.writeUInt32LE(36 + dataSize, 4);             // ChunkSize
  header.write('WAVE', 8);                            // Format
  header.write('fmt ', 12);                           // Subchunk1ID
  header.writeUInt32LE(16, 16);                       // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20);                        // AudioFormat (1 = PCM)
  header.writeUInt16LE(numChannels, 22);              // NumChannels
  header.writeUInt32LE(sampleRate, 24);               // SampleRate
  header.writeUInt32LE(byteRate, 28);                 // ByteRate
  header.writeUInt16LE(blockAlign, 32);               // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34);            // BitsPerSample
  header.write('data', 36);                           // Subchunk2ID
  header.writeUInt32LE(dataSize, 40);                 // Subchunk2Size

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Helper: Call Gemini Flash TTS and return base64 WAV audio.
 * Gemini returns raw PCM which we wrap in a WAV header for browser playback.
 * Includes retry logic for transient errors (rate limits, TTS confusion).
 * Falls back to OpenAI TTS if Gemini fails after retries.
 */
/**
 * Rhubarb Lip Sync — analyzes actual audio waveform for frame-accurate visemes.
 * Maps Rhubarb's A-H shapes to Oculus viseme names.
 */
let Rhubarb = null;
try {
  Rhubarb = require('rhubarb-lip-sync-wasm').Rhubarb;
  console.log('Rhubarb Lip Sync loaded');
} catch (e) {
  console.warn('Rhubarb Lip Sync not available, using text-based fallback:', e.message);
}

// Rhubarb shape → Oculus viseme mapping
const RHUBARB_TO_VISEME = {
  'A': 'viseme_PP',   // Closed (M, B, P)
  'B': 'viseme_DD',   // Slightly open (most consonants)
  'C': 'viseme_E',    // Open (E, AE)
  'D': 'viseme_aa',   // Wide open (A, I)
  'E': 'viseme_O',    // Rounded (O)
  'F': 'viseme_U',    // Puckered (U, OO, W)
  'G': 'viseme_FF',   // F/V (teeth on lip)
  'H': 'viseme_nn',   // L (tongue)
  'X': 'viseme_sil',  // Silence
};

/**
 * Downsample 24kHz 16-bit PCM to 16kHz for Rhubarb.
 */
function downsamplePcm(pcmBuffer, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const srcSamples = pcmBuffer.length / 2; // 16-bit = 2 bytes
  const dstSamples = Math.floor(srcSamples / ratio);
  const dst = Buffer.alloc(dstSamples * 2);
  for (let i = 0; i < dstSamples; i++) {
    const srcIdx = Math.floor(i * ratio);
    dst.writeInt16LE(pcmBuffer.readInt16LE(srcIdx * 2), i * 2);
  }
  return dst;
}

/**
 * Generate viseme timeline from audio using Rhubarb Lip Sync.
 * Falls back to text-based estimation if Rhubarb fails.
 */
async function generateVisemeTimeline(pcmBuffer, sampleRate, text, durationSec) {
  // Try Rhubarb first — frame-accurate from actual audio
  if (Rhubarb) {
    try {
      const startTime = Date.now();
      // Rhubarb needs 16kHz PCM
      const pcm16k = sampleRate === 16000 ? pcmBuffer : downsamplePcm(pcmBuffer, sampleRate, 16000);
      const result = await Rhubarb.lipSync(pcm16k, { dialogText: text });
      const elapsed = Date.now() - startTime;

      if (result && result.mouthCues && result.mouthCues.length > 0) {
        const timeline = result.mouthCues.map(cue => ({
          time: Math.round(cue.start * 1000) / 1000,
          duration: Math.round((cue.end - cue.start) * 1000) / 1000,
          viseme: RHUBARB_TO_VISEME[cue.value] || 'viseme_sil',
        }));
        console.log(`[RHUBARB] ${timeline.length} cues in ${elapsed}ms for ${Math.round(durationSec * 10) / 10}s audio`);
        return timeline;
      }
    } catch (e) {
      console.warn('[RHUBARB] Failed, using text fallback:', e.message);
    }
  }

  // Fallback: text-based estimation (original approach)
  return generateVisemeTimelineFromText(text, durationSec);
}

/**
 * Text-based viseme timeline fallback.
 * Maps German graphemes to Oculus visemes and estimates timing.
 */
function generateVisemeTimelineFromText(text, audioDurationSec) {
  const GRAPHEME_TO_VISEME = {
    'a': 'viseme_aa', 'ä': 'viseme_aa', 'ah': 'viseme_aa',
    'e': 'viseme_E', 'eh': 'viseme_E', 'ee': 'viseme_E',
    'i': 'viseme_I', 'ie': 'viseme_I', 'ih': 'viseme_I',
    'o': 'viseme_O', 'oh': 'viseme_O', 'oo': 'viseme_O', 'ö': 'viseme_O',
    'u': 'viseme_U', 'uh': 'viseme_U', 'ü': 'viseme_U',
    'ei': 'viseme_aa', 'ai': 'viseme_aa', 'au': 'viseme_aa',
    'eu': 'viseme_O', 'äu': 'viseme_O',
    'b': 'viseme_PP', 'p': 'viseme_PP', 'm': 'viseme_PP',
    'f': 'viseme_FF', 'v': 'viseme_FF', 'w': 'viseme_FF', 'pf': 'viseme_FF',
    'th': 'viseme_TH',
    't': 'viseme_DD', 'd': 'viseme_DD', 'n': 'viseme_nn',
    'k': 'viseme_kk', 'g': 'viseme_kk', 'c': 'viseme_kk', 'ck': 'viseme_kk', 'q': 'viseme_kk',
    'ch': 'viseme_CH', 'j': 'viseme_CH',
    's': 'viseme_SS', 'z': 'viseme_SS', 'ß': 'viseme_SS', 'tz': 'viseme_SS',
    'sch': 'viseme_CH', 'sp': 'viseme_CH', 'st': 'viseme_CH',
    'r': 'viseme_RR', 'l': 'viseme_nn',
    'h': 'viseme_kk', 'x': 'viseme_kk',
  };

  const cleanText = text.toLowerCase().replace(/[^a-zäöüß\s]/g, '');
  const words = cleanText.split(/\s+/).filter(Boolean);
  const phonemes = [];
  for (const word of words) {
    let i = 0;
    while (i < word.length) {
      let matched = false;
      for (const len of [3, 2, 1]) {
        const chunk = word.slice(i, i + len);
        if (GRAPHEME_TO_VISEME[chunk]) {
          phonemes.push({ viseme: GRAPHEME_TO_VISEME[chunk], isVowel: 'aeiouäöü'.includes(chunk[0]) });
          i += len; matched = true; break;
        }
      }
      if (!matched) i++;
    }
    phonemes.push({ viseme: 'viseme_sil', isVowel: false });
  }
  if (phonemes.length === 0) return [];
  const totalWeight = phonemes.reduce((sum, p) => sum + (p.isVowel ? 1.5 : 0.8), 0);
  const timePerWeight = audioDurationSec / totalWeight;
  const timeline = [];
  let currentTime = 0;
  for (const p of phonemes) {
    const duration = (p.isVowel ? 1.5 : 0.8) * timePerWeight;
    timeline.push({
      time: Math.round(currentTime * 1000) / 1000,
      viseme: p.viseme,
      duration: Math.round(duration * 1000) / 1000,
    });
    currentTime += duration;
  }
  return timeline;
}

// ══════════════════════════════════════════════════════════════════════════════
// AZURE SPEECH TTS — 55 ARKit blend shapes at 60fps for movie-quality lip sync
// ══════════════════════════════════════════════════════════════════════════════

const sdk = require('microsoft-cognitiveservices-speech-sdk');

// Azure blend shape order → ARKit shape name (55 positions)
const AZURE_BLEND_SHAPE_NAMES = [
  'eyeBlinkLeft', 'eyeLookDownLeft', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft',
  'eyeSquintLeft', 'eyeWideLeft',
  'eyeBlinkRight', 'eyeLookDownRight', 'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpRight',
  'eyeSquintRight', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawRight', 'jawOpen',
  'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthDimpleLeft', 'mouthDimpleRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthPressLeft', 'mouthPressRight', 'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight',
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'noseSneerLeft', 'noseSneerRight',
  'tongueOut',
  'headRoll', 'leftEyeRoll', 'rightEyeRoll',
];

/**
 * Azure Speech TTS with blend shapes.
 * Returns audio + per-frame blend shape data (55 ARKit shapes at 60fps).
 */
async function textToSpeechAzure(text) {
  const speechKey = process.env.AZURE_SPEECH_KEY;
  const speechRegion = process.env.AZURE_SPEECH_REGION;
  if (!speechKey || !speechRegion) {
    throw new Error('Azure Speech credentials not configured');
  }

  const speechConfig = sdk.SpeechConfig.fromSubscription(speechKey, speechRegion);
  speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm;

  return new Promise((resolve, reject) => {
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);
    const blendShapeFrames = []; // Array of { time, shapes: {name: value} }
    let frameCount = 0;
    let visemeEventCount = 0;

    // Subscribe to blend shape events
    synthesizer.visemeReceived = (s, e) => {
      visemeEventCount++;
      if (visemeEventCount <= 3) {
        console.log(`[TTS] visemeReceived #${visemeEventCount}: visemeId=${e.visemeId}, audioOffset=${e.audioOffset}, animation=${e.animation ? e.animation.substring(0, 120) + '...' : 'null'}`);
      }
      if (e.animation) {
        try {
          const data = JSON.parse(e.animation);
          const startFrame = data.FrameIndex || frameCount;

          // Each row in BlendShapes is one frame (60fps)
          if (data.BlendShapes) {
            for (let i = 0; i < data.BlendShapes.length; i++) {
              const frameValues = data.BlendShapes[i];
              const frameTimeMs = (startFrame + i) * (1000 / 60); // 60fps
              const shapes = {};
              for (let j = 0; j < frameValues.length && j < AZURE_BLEND_SHAPE_NAMES.length; j++) {
                if (frameValues[j] > 0.01) { // Only include non-zero shapes
                  shapes[AZURE_BLEND_SHAPE_NAMES[j]] = Math.round(frameValues[j] * 1000) / 1000;
                }
              }
              blendShapeFrames.push({ time: Math.round(frameTimeMs) / 1000, shapes });
              frameCount = startFrame + i + 1;
            }
          }
        } catch (parseErr) {
          console.warn('[TTS] Failed to parse animation data:', parseErr.message);
        }
      }
    };

    // SSML requesting blend shapes — female voice (SeraphinaNeural: expressive, multilingual)
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="de-DE">
  <voice name="de-DE-SeraphinaMultilingualNeural">
    <mstts:viseme type="FacialExpression"/>
    ${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}
  </voice>
</speak>`;

    synthesizer.speakSsmlAsync(ssml,
      (result) => {
        synthesizer.close();
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          const audioBuffer = Buffer.from(result.audioData);
          console.log(`[TTS] Azure: ${audioBuffer.length} bytes audio, ${blendShapeFrames.length} blend shape frames, ${visemeEventCount} viseme events`);
          resolve({
            audioBase64: audioBuffer.toString('base64'),
            mimeType: 'audio/wav',
            blendShapes: blendShapeFrames,
            visemeTimeline: [],
          });
        } else {
          const err = result.errorDetails || 'Azure TTS synthesis failed';
          console.warn('[TTS] Azure failed:', err);
          reject(new Error(err));
        }
      },
      (err) => {
        synthesizer.close();
        reject(err);
      }
    );
  });
}

async function textToSpeechGemini(text, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await googleAI.models.generateContent({
        model: 'gemini-2.5-pro-tts',
        systemInstruction: 'Imagine you are at a cafe having a conversation with a friend. You are calm, comforting, but also excited to see them. Your friend is a non-native speaker of your language, so you stress important words in your sentences to help them understand better, but really focus on a good flow of your sentences, including deliberate pauses when the content shifts. You are expressive. For example, when the other person does not respond, you may raise your voice to remind them you are still there, but you are never intimidating and always nice.',
        contents: [{ role: 'user', parts: [{ text: `Say exactly this in German: ${text}` }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Achernar',
              },
            },
            languageCode: 'de-DE',
          },
        },
      });

      const audioPart = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (!audioPart?.data) {
        throw new Error('No audio data in Gemini TTS response');
      }

      const rawMime = audioPart.mimeType || '';
      console.log('[TTS] Gemini response mimeType:', rawMime);

      // If Gemini returns raw PCM (audio/L16 or similar), wrap in WAV header
      if (rawMime.includes('L16') || rawMime.includes('pcm') || rawMime.includes('raw') || (!rawMime.includes('wav') && !rawMime.includes('mp3') && !rawMime.includes('ogg'))) {
        const rateMatch = rawMime.match(/rate=(\d+)/);
        const sampleRate = rateMatch ? parseInt(rateMatch[1]) : 24000;
        const pcmBuffer = Buffer.from(audioPart.data, 'base64');
        const wavBuffer = wrapPcmInWav(pcmBuffer, sampleRate);
        // Calculate audio duration and generate viseme timeline from actual audio
        return { audioBase64: wavBuffer.toString('base64'), mimeType: 'audio/wav' };
      }

      return { audioBase64: audioPart.data, mimeType: rawMime };

    } catch (err) {
      const errMsg = err.message || JSON.stringify(err);
      console.warn(`[TTS] Gemini attempt ${attempt + 1}/${retries + 1} failed:`, errMsg);

      // Rate limit — check if it's a daily quota (hours-long wait) vs transient spike
      if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
        // If retry delay is > 60 seconds, it's a daily quota — skip retries, fall back immediately
        const delayMatch = errMsg.match(/retryDelay.*?(\d+)s/);
        const retryDelaySec = delayMatch ? parseInt(delayMatch[1]) : 0;
        if (retryDelaySec > 60) {
          console.log(`[TTS] Gemini daily quota hit (reset in ${Math.round(retryDelaySec / 60)}min). Falling back to OpenAI TTS.`);
          return textToSpeechOpenAI(text);
        }
        // Transient rate limit — short wait and retry
        const waitMs = (attempt + 1) * 3000;
        console.log(`[TTS] Rate limited, waiting ${waitMs}ms before retry...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      // TTS model confusion — retry once with simpler prompt
      if (errMsg.includes('tried to generate text') && attempt < retries) {
        console.log('[TTS] Gemini TTS confused, retrying...');
        continue;
      }
      // Final attempt failed — fall back to OpenAI TTS
      if (attempt >= retries) {
        console.log('[TTS] Gemini failed, falling back to OpenAI TTS');
        return textToSpeechOpenAI(text);
      }
    }
  }
  // Should not reach here, but fallback just in case
  return textToSpeechOpenAI(text);
}

/**
 * Fallback TTS using OpenAI tts-1 when Gemini is unavailable.
 */
async function textToSpeechOpenAI(text) {
  console.log('[TTS] Using OpenAI TTS fallback');
  const mp3 = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'onyx',
    input: text,
    speed: 0.95,
    response_format: 'mp3',
  });
  const buffer = Buffer.from(await mp3.arrayBuffer());
  return { audioBase64: buffer.toString('base64'), mimeType: 'audio/mpeg' };
}

/**
 * Main TTS function — tries Azure (for blend shapes) first, falls back to Gemini.
 */
async function textToSpeech(text) {
  return textToSpeechGemini(text);
}

// ══════════════════════════════════════════════════════════════════════════════
// VOCABULARY & GRAMMAR VALIDATION
// Post-generation check: every word Claude produces is validated against the
// cumulative allowed word set. Violations trigger a re-generation with
// specific correction instructions.
// ══════════════════════════════════════════════════════════════════════════════

// German functional words that are ALWAYS allowed regardless of unit level.
// These are the "glue" of the language — articles, pronouns, prepositions, etc.
const FUNCTIONAL_WORDS = new Set([
  // Articles
  'der', 'die', 'das', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'kein', 'keine', 'keinen', 'keinem', 'keiner',
  // Pronouns
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'man', 'xier',
  'mich', 'dich', 'sich', 'uns', 'euch',
  'mir', 'dir', 'ihm', 'ihr',
  'mein', 'meine', 'meinen', 'meinem', 'meiner', 'meines',
  'dein', 'deine', 'deinen', 'deinem', 'deiner', 'deines',
  'sein', 'seine', 'seinen', 'seinem', 'seiner', 'seines',
  'ihr', 'ihre', 'ihren', 'ihrem', 'ihrer', 'ihres',
  'unser', 'unsere', 'unseren', 'unserem', 'unserer',
  'euer', 'eure', 'euren', 'eurem', 'eurer',
  'das', 'dies', 'diese', 'dieser', 'dieses', 'diesen', 'diesem',
  'wer', 'was', 'wen', 'wem', 'wessen',
  'welch', 'welche', 'welcher', 'welches', 'welchen', 'welchem',
  // Prepositions
  'in', 'an', 'auf', 'aus', 'bei', 'mit', 'nach', 'von', 'zu', 'zum', 'zur',
  'für', 'um', 'über', 'unter', 'vor', 'hinter', 'neben', 'zwischen',
  'bis', 'durch', 'gegen', 'ohne', 'seit',
  // Conjunctions
  'und', 'oder', 'aber', 'denn', 'sondern', 'doch',
  // Adverbs / particles (very common, always needed)
  'nicht', 'auch', 'schon', 'noch', 'sehr', 'gern', 'gerne',
  'dann', 'jetzt', 'hier', 'dort', 'da', 'so', 'wie', 'wo', 'woher', 'wohin',
  'wann', 'warum', 'immer', 'oft', 'manchmal', 'nie',
  'heute', 'morgen', 'morgens', 'nachmittags', 'abends',
  'ja', 'nein', 'vielleicht',
  // Question words
  'was', 'wer', 'wie', 'wo', 'woher', 'wann', 'warum',
  // Common verbs (sein, haben, werden — always needed)
  'ist', 'sind', 'bin', 'bist', 'seid', 'war', 'waren',
  'hat', 'hast', 'habe', 'haben', 'habt',
  'wird', 'wirst', 'werden', 'werdet',
  // Modal helpers
  'kann', 'kannst', 'können', 'könnt',
  'muss', 'musst', 'müssen', 'müsst',
  'will', 'willst', 'wollen', 'wollt',
  'soll', 'sollst', 'sollen', 'sollt',
  'darf', 'darfst', 'dürfen', 'dürft',
  // Common short words
  'es', 'mal', 'doch', 'lass', 'uns', 'okay',
]);

// Numbers are always allowed
const NUMBER_WORDS = new Set([
  'null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht',
  'neun', 'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn',
  'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn', 'zwanzig', 'dreißig',
  'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig', 'hundert',
  'einundzwanzig', 'zweiundzwanzig',
]);

/**
 * Extract all word forms from a vocabulary entry and add to a Set.
 * Handles articles ("der Pullover" → "pullover"), compound words,
 * reflexive verbs ("sich freuen" → "freuen"), etc.
 */
function addVocabToSet(set, word) {
  if (!word) return;
  const lower = word.toLowerCase().trim();
  set.add(lower);

  // Strip leading articles: "der Pullover" → "Pullover"
  const noArticle = lower.replace(/^(der|die|das|ein|eine|einen|einem)\s+/i, '').trim();
  if (noArticle) set.add(noArticle);

  // Strip reflexive "sich": "sich freuen" → "freuen"
  const noSich = noArticle.replace(/^sich\s+/i, '').trim();
  if (noSich && noSich !== noArticle) set.add(noSich);

  // Handle multi-word entries: "kein Problem" → "kein", "problem"
  for (const part of lower.split(/\s+/)) {
    if (part.length > 1) set.add(part);
  }
}

/**
 * Build the allowed word set for a session from cumulative vocabulary data.
 * Returns { allowed: Set, passiveSet: Set } of lowercase word forms.
 */
function buildAllowedWordSet(cumulativeData, universalFillers) {
  const allowed = new Set();

  // 1. All active vocabulary words
  for (const item of (cumulativeData.activeVocabulary || [])) {
    const word = typeof item === 'object' ? item.word : item;
    addVocabToSet(allowed, word);
  }

  // 2. Passive vocabulary — tracked separately
  const passiveSet = new Set();
  for (const item of (cumulativeData.passiveVocabulary || [])) {
    const word = typeof item === 'object' ? item.word : item;
    addVocabToSet(passiveSet, word);
  }

  // 3. All allowed verb conjugations
  const verbForms = cumulativeData.verbForms || {};
  for (const [verb, tenses] of Object.entries(verbForms)) {
    allowed.add(verb.toLowerCase());
    for (const [, persons] of Object.entries(tenses)) {
      for (const [, form] of Object.entries(persons)) {
        if (form) {
          // "stehe auf" → "stehe", "auf"
          for (const p of form.split(/\s+/)) allowed.add(p.toLowerCase());
        }
      }
    }
  }

  // 4. Universal fillers — loaded at startup, always the same
  for (const w of UNIVERSAL_FILLER_WORDS) allowed.add(w);

  // Also add from the request body if provided (belt and suspenders)
  if (universalFillers) {
    for (const category of Object.values(universalFillers)) {
      if (Array.isArray(category)) {
        for (const filler of category) {
          for (const word of filler.toLowerCase().replace(/[.,!?]/g, '').split(/\s+/)) {
            if (word.length > 0) allowed.add(word);
          }
        }
      }
    }
  }

  // 5. Functional words, numbers, common contractions
  for (const w of FUNCTIONAL_WORDS) allowed.add(w);
  for (const w of NUMBER_WORDS) allowed.add(w);

  // 6. Common contractions and colloquial forms always allowed
  const CONTRACTIONS = [
    "geht's", "gehts", "wie's", "gibt's", "gibts", "ist's",
    "hab's", "hab", "habs", "was's", "lass",
    "drauf", "dran", "drin", "drüber", "drunter",
    "rein", "raus", "runter", "rüber",
  ];
  for (const c of CONTRACTIONS) allowed.add(c);

  return { allowed, passiveSet };
}

/**
 * Validate a buddy response against the allowed word set.
 * Returns { valid: true } or { valid: false, violations: [...], suggestions: string }
 */
function validateResponse(text, allowedSet, passiveSet, studentWords) {
  // Strip any [BRACKETED] content before tokenizing (e.g. emotion tags like [HAPPY])
  // This does NOT modify the original text — only the copy used for validation
  const textForValidation = text.replace(/\[[^\]]*\]\s*/g, ' ');

  // Tokenize: keep hyphenated words together, handle contractions
  const rawTokens = textForValidation
    .replace(/[.,!?;:""„"«»—–\(\)\[\]]/g, ' ')  // Remove punctuation (but keep hyphens)
    .split(/\s+/)
    .filter(w => w.length > 0);

  // Normalize tokens: handle hyphens and contractions
  const words = [];
  for (const token of rawTokens) {
    // Skip single characters
    if (token.length <= 1) continue;

    // Keep contractions as-is for checking: "geht's" stays "geht's"
    // But also check without apostrophe
    words.push(token);
  }

  const violations = [];
  const studentWordSet = new Set((studentWords || []).map(w => w.toLowerCase()));
  const seen = new Set(); // Avoid reporting same word twice

  for (const word of words) {
    const lower = word.toLowerCase().replace(/[''`]/g, "'"); // Normalize quotes

    // Skip very short words (1-2 chars are usually particles/articles)
    if (lower.length <= 2) continue;

    // Skip if already checked
    if (seen.has(lower)) continue;
    seen.add(lower);

    // Check the full word first
    if (allowedSet.has(lower)) continue;

    // Check without trailing apostrophe-s: "geht's" → "geht"
    const noApostrophe = lower.replace(/'s$/, '');
    if (noApostrophe !== lower && allowedSet.has(noApostrophe)) continue;

    // Check hyphenated word parts: "T-Shirts" → check "T-Shirts", "T-Shirt", "Shirts", "Shirt"
    if (lower.includes('-')) {
      const parts = lower.split('-');
      const allPartsOk = parts.every(p => p.length <= 1 || allowedSet.has(p) || FUNCTIONAL_WORDS.has(p));
      if (allPartsOk) continue;
      // Also check the whole hyphenated form and singular
      const singular = lower.replace(/s$/, '');
      if (allowedSet.has(singular)) continue;
    }

    // Check singular form (remove trailing -s, -e, -en, -er, -es, -n)
    const singulars = [
      lower.replace(/en$/, ''), lower.replace(/er$/, ''), lower.replace(/es$/, ''),
      lower.replace(/e$/, ''), lower.replace(/s$/, ''), lower.replace(/n$/, ''),
    ];
    if (singulars.some(s => s.length > 2 && allowedSet.has(s))) continue;

    // Skip functional words and numbers
    if (FUNCTIONAL_WORDS.has(lower)) continue;
    if (NUMBER_WORDS.has(lower)) continue;

    // Capitalized words: In German, ALL nouns are capitalized, so we can't
    // just skip them as proper nouns. Instead, check if they're known vocab.
    // Only skip as proper noun if it's NOT a known passive/active word
    // (i.e., it's truly unknown — likely a name or place).
    if (/^[A-ZÄÖÜ][a-zäöüß]{2,}$/.test(word)) {
      // Check if it's a known German word (active or passive)
      if (!allowedSet.has(lower) && !passiveSet.has(lower) && !singulars.some(s => allowedSet.has(s) || passiveSet.has(s))) {
        // Not in any vocab list → likely a proper noun (name, city) → allow
        continue;
      }
      // It IS a known word → fall through to the passive/violation check below
    }

    // Skip if student introduced this word
    if (studentWordSet.has(lower)) continue;

    // Check if it's passive vocab (buddy shouldn't use unless student said first)
    const isPassive = passiveSet.has(lower) || singulars.some(s => passiveSet.has(s));
    if (isPassive && !studentWordSet.has(lower)) {
      violations.push({ word, reason: 'passive_only' });
      continue;
    }

    // Unknown word — violation
    violations.push({ word, reason: 'not_in_vocab' });
  }

  if (violations.length === 0) return { valid: true };

  // Build correction message
  const passiveViolations = violations.filter(v => v.reason === 'passive_only');
  const unknownViolations = violations.filter(v => v.reason === 'not_in_vocab');

  let suggestion = 'Rephrase your response. ';
  if (unknownViolations.length > 0) {
    suggestion += `These words are NOT in the student's vocabulary and must be replaced: ${unknownViolations.map(v => `"${v.word}"`).join(', ')}. `;
  }
  if (passiveViolations.length > 0) {
    suggestion += `These words are PASSIVE vocabulary only — do not use them unless the student said them first: ${passiveViolations.map(v => `"${v.word}"`).join(', ')}. `;
  }
  suggestion += 'Use ONLY words from the active vocabulary list in Section 5. Find simpler alternatives.';

  return { valid: false, violations, suggestion };
}

/**
 * Validate grammar constraints in a response.
 * Checks for forbidden structures that are hard for the LLM to avoid.
 */
function validateGrammar(text, grammarConstraints) {
  if (!grammarConstraints) return { valid: true };

  const forbidden = grammarConstraints.forbidden || [];
  const allowedCases = grammarConstraints.allowed_cases || [];
  const allowedSentenceTypes = grammarConstraints.sentence_types || [];
  const issues = [];

  const lower = text.toLowerCase();

  // Check subordinate clauses if forbidden
  const subordinatesAllowed = allowedSentenceTypes.some(t =>
    t.includes('subordinate') || t.includes('wenn') || t.includes('weil')
  );
  if (!subordinatesAllowed) {
    // Check for common subordinate clause markers
    if (/\b(wenn|weil|dass|obwohl|damit|bevor|nachdem|während)\b/i.test(text)) {
      const match = text.match(/\b(wenn|weil|dass|obwohl|damit|bevor|nachdem|während)\b/i);
      issues.push(`Subordinate clause with "${match[1]}" is forbidden. Use simple sentences instead.`);
    }
  }

  // Check dative if forbidden
  const dativeAllowed = allowedCases.includes('dative');
  if (!dativeAllowed) {
    // Check for common dative markers
    if (/\b(dem|vom|zum|beim|am)\b/i.test(text) && !/\bam\s+(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|Wochenende)\b/i.test(text)) {
      // "am" + weekday is acceptable even without dative (it's a fixed expression taught early)
      // But "am liebsten", "nach dem", "vom" etc. are dative
      const match = text.match(/\b(dem|vom|zum|beim)\b/i);
      if (match) issues.push(`Dative case "${match[0]}" is forbidden. Only nominative and accusative are allowed.`);
    }
  }

  // Check for Konjunktiv II (möchtest, könnte, würde, etc.)
  const konjunktivAllowed = (grammarConstraints.allowed_tenses || []).some(t =>
    t.toLowerCase().includes('konjunktiv')
  );
  if (!konjunktivAllowed) {
    if (/\b(möchtest?|könntest?|würdest?|hätte|wäre|könnte|müsste|sollte)\b/i.test(text)) {
      const match = text.match(/\b(möchtest?|könntest?|würdest?|hätte|wäre|könnte|müsste|sollte)\b/i);
      issues.push(`Konjunktiv II form "${match[1]}" is forbidden. Use present tense (e.g., "magst" instead of "möchtest").`);
    }
  }

  if (issues.length === 0) return { valid: true };

  return {
    valid: false,
    issues,
    suggestion: `Grammar violations found: ${issues.join(' ')} Rephrase using only allowed grammar.`,
  };
}

/**
 * Validate and optionally re-generate a Claude response.
 * Returns the final validated response text.
 */
async function validateAndCorrect(responseText, session, maxRetries = 3) {
  if (!session.allowedWordSet) return responseText; // No validation data available

  const { allowed, passiveSet } = session.allowedWordSet;

  // Collect words the student has introduced in this session
  const studentWords = [];
  for (const entry of (session.fullTranscript || [])) {
    if (entry.role === 'student') {
      const words = entry.text.replace(/[.,!?;:]/g, ' ').split(/\s+/);
      for (const w of words) if (w.length > 1) studentWords.push(w);
    }
  }

  // Specific alternatives for common forbidden patterns
  const ALTERNATIVES = {
    // Grammar alternatives
    'wenn': 'Do NOT use "wenn". Use two simple sentences instead. Example: "Es ist kalt. Trägst du eine Jacke?"',
    'weil': 'Do NOT use "weil". Use two sentences instead. Example: "Das ist toll. Du magst Musik!"',
    'dass': 'Do NOT use "dass". Rephrase as a direct statement or question.',
    'ob': 'Do NOT use "ob". Ask directly instead.',
    'beim': 'Do NOT use "beim" (dative). Say "Spielst du Fußball?" not "beim Spielen".',
    'zum': 'Do NOT use "zum" (dative). Say "Spielst du gern?" not "zum Spielen".',
    'zur': 'Do NOT use "zur" (dative). Say "Gehst du in die Schule?" not "zur Schule".',
    'vom': 'Do NOT use "vom" (dative). Rephrase the sentence.',
    'mit': 'Do NOT use "mit" (dative). Say "und" instead. Example: "Ich und mein Bruder" not "mit meinem Bruder".',
    // Vocab alternatives
    'pullover': 'Do NOT use "Pullover" (passive). Use "Jacke" instead.',
    'sneaker': 'Do NOT use "Sneaker" (passive). Use "Schuhe" instead.',
    'warm': 'Do NOT use "warm" (passive). Ask "Ist es sonnig?" or "Ist es heiß?" instead.',
    'kennenzulernen': 'Do NOT use "kennenzulernen". Say "Schön!" or "Toll!" instead.',
    'bisschen': 'Do NOT use "bisschen". Say "noch" or "mehr" instead.',
    'gemütlich': 'Do NOT use "gemütlich". Say "schön" or "toll" instead.',
    'frühstück': 'Do NOT use "Frühstück". Ask "Was machst du dann?" to stay on Tagesablauf.',
    'brot': 'Do NOT use "Brot" (not in vocabulary). Stay on the assigned topic.',
    'essen': 'Do NOT use "essen" (not in vocabulary). Stay on the assigned topic.',
  };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const vocabResult = validateResponse(responseText, allowed, passiveSet, studentWords);
    const grammarResult = validateGrammar(responseText, session.grammarConstraints);

    if (vocabResult.valid && grammarResult.valid) {
      if (attempt > 0) console.log(`[VALIDATOR] ✅ Response passed after ${attempt + 1} attempts`);
      return responseText;
    }

    // Log violations
    if (!vocabResult.valid) {
      console.log(`[VALIDATOR] ❌ Vocab violations: ${vocabResult.violations.map(v => `${v.word} (${v.reason})`).join(', ')}`);
    }
    if (!grammarResult.valid) {
      console.log(`[VALIDATOR] ❌ Grammar violations: ${grammarResult.issues.join('; ')}`);
    }

    // Build correction prompt with SPECIFIC alternatives
    let correctionMsg = `[SYSTEM: REWRITE REQUIRED (attempt ${attempt + 1}/${maxRetries}). Your response "${responseText}" has violations:\n`;
    const allViolatingWords = [];

    if (!vocabResult.valid) {
      for (const v of vocabResult.violations) {
        const lower = v.word.toLowerCase();
        allViolatingWords.push(lower);
        const alt = ALTERNATIVES[lower];
        if (alt) {
          correctionMsg += `- ${alt}\n`;
        } else if (v.reason === 'passive_only') {
          correctionMsg += `- "${v.word}" is PASSIVE — the student hasn't said it. Find a different word from the active list.\n`;
        } else {
          correctionMsg += `- "${v.word}" is NOT allowed. Remove it or use a simpler word.\n`;
        }
      }
    }
    if (!grammarResult.valid) {
      for (const issue of grammarResult.issues) {
        // Extract the trigger word from the grammar issue
        const wordMatch = issue.match(/"(\w+)"/);
        if (wordMatch) {
          const lower = wordMatch[1].toLowerCase();
          allViolatingWords.push(lower);
          const alt = ALTERNATIVES[lower];
          if (alt) {
            correctionMsg += `- ${alt}\n`;
          } else {
            correctionMsg += `- ${issue}\n`;
          }
        } else {
          correctionMsg += `- ${issue}\n`;
        }
      }
    }

    correctionMsg += `\nRULES:\n`;
    correctionMsg += `- Use ONLY simple main clauses (Subject + Verb + Object).\n`;
    correctionMsg += `- NO subordinate clauses (no wenn, weil, dass, ob, bevor, während).\n`;
    correctionMsg += `- NO dative prepositions (no bei/beim, zu/zum/zur, mit, von/vom, nach, seit).\n`;
    correctionMsg += `- Split complex sentences into two short ones.\n`;
    correctionMsg += `- FORBIDDEN words in this rewrite: ${allViolatingWords.join(', ')}\n`;
    correctionMsg += `- Keep the same conversational intent. Be SHORT — one or two simple sentences max.\n`;
    correctionMsg += `- IMPORTANT: Prefix EACH sentence with an emotion tag like [HAPPY], [CURIOUS], etc.]`;

    // Re-generate
    session.history.pop(); // Remove the bad assistant response
    session.history.push({ role: 'user', content: correctionMsg });
    responseText = await callClaude(session.systemPrompt, session.history);
    session.history.pop(); // Remove the correction prompt
    session.history.push({ role: 'assistant', content: responseText });

    console.log(`[VALIDATOR] Re-generated (attempt ${attempt + 1}): "${responseText}"`);
  }

  // Final check — if STILL failing, strip the violating words as last resort
  const finalVocab = validateResponse(responseText, allowed, passiveSet, studentWords);
  const finalGrammar = validateGrammar(responseText, session.grammarConstraints);
  if (!finalVocab.valid || !finalGrammar.valid) {
    console.log(`[VALIDATOR] ⚠️ Still has issues after ${maxRetries} corrections — attempting word-level fix`);

    // Last resort: remove sentences containing forbidden words
    const allBadWords = [
      ...(finalVocab.valid ? [] : finalVocab.violations.map(v => v.word.toLowerCase())),
    ];
    if (allBadWords.length > 0) {
      const sentences = responseText.split(/(?<=[.!?])\s+/).filter(s => s.trim());
      const cleanSentences = sentences.filter(s => {
        const sLower = s.toLowerCase();
        return !allBadWords.some(w => sLower.includes(w));
      });
      if (cleanSentences.length > 0) {
        responseText = cleanSentences.join(' ');
        session.history.pop();
        session.history.push({ role: 'assistant', content: responseText });
        console.log(`[VALIDATOR] ✂️ Stripped bad sentences: "${responseText}"`);
      } else {
        console.log(`[VALIDATOR] ⚠️ Could not fix — accepting as-is`);
      }
    }
  }

  return responseText;
}

/**
 * Helper: Call Claude Haiku 4.5 with conversation history.
 */
// Valid emotion tags that Claude can prefix responses with
const VALID_EMOTIONS = ['HAPPY', 'EXCITED', 'CURIOUS', 'EMPATHETIC', 'THINKING', 'NEUTRAL', 'CONCERNED', 'SURPRISED'];
const EMOTION_TAG_RE = /^\[(HAPPY|EXCITED|CURIOUS|EMPATHETIC|THINKING|NEUTRAL|CONCERNED|SURPRISED)\]\s*/i;
const EMOTION_TAG_ALL_RE = /\[(HAPPY|EXCITED|CURIOUS|EMPATHETIC|THINKING|NEUTRAL|CONCERNED|SURPRISED)\]\s*/gi;

async function callClaude(systemPrompt, messages) {
  // Append emotion tagging instruction to the system prompt
  const emotionInstruction = `\n\nEMOTION TAGGING (mandatory): Tag EACH sentence with an emotion in brackets. Available: [HAPPY], [EXCITED], [CURIOUS], [EMPATHETIC], [THINKING], [NEUTRAL], [CONCERNED], [SURPRISED]. Tags are stripped before speaking — the student never sees them.

Guidelines:
- [CURIOUS] when asking a follow-up or the student says something interesting.
- [EMPATHETIC] when the student shares feelings, frustration, or success.
- [HAPPY] for warm greetings, compliments, or good conversation flow.
- [EXCITED] for enthusiastic reactions.
- [THINKING] when pausing to consider or suggest.
- [CONCERNED] when the student seems confused or struggling.
- [SURPRISED] for genuine surprise.
- [NEUTRAL] for standard factual delivery.

Example: "[EXCITED] Oh, cool! [HAPPY] Du magst also Musik! [CURIOUS] Spielst du ein Instrument?"`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    temperature: 0.55,
    system: systemPrompt + emotionInstruction,
    messages,
  });
  return response.content[0].text;
}

/**
 * Parse per-sentence emotion tags from Claude's response.
 * Input:  "[EXCITED] Oh, cool! [HAPPY] Du magst Musik! [CURIOUS] Spielst du?"
 * Returns { text, emotion, emotionTimeline }
 *   - text: clean text with all tags stripped
 *   - emotion: first emotion (for backwards compat)
 *   - emotionTimeline: [{ start: 0.0-1.0, emotion }] proportional segments
 */
function parseEmotion(responseText) {
  // Match all emotion tags with their positions
  const tagPattern = /\[(HAPPY|EXCITED|CURIOUS|EMPATHETIC|THINKING|NEUTRAL|CONCERNED|SURPRISED)\]\s*/gi;
  const segments = [];
  let lastIdx = 0;
  let lastEmotion = 'neutral';
  let match;

  while ((match = tagPattern.exec(responseText)) !== null) {
    // Text before this tag belongs to the previous emotion
    const textBefore = responseText.slice(lastIdx, match.index);
    if (textBefore.trim()) {
      segments.push({ text: textBefore.trim(), emotion: lastEmotion });
    }
    lastEmotion = match[1].toLowerCase();
    lastIdx = match.index + match[0].length;
  }
  // Remaining text after last tag
  const remaining = responseText.slice(lastIdx);
  if (remaining.trim()) {
    segments.push({ text: remaining.trim(), emotion: lastEmotion });
  }

  // If no tags found at all, return as neutral
  if (segments.length === 0) {
    return { text: responseText, emotion: 'neutral', emotionTimeline: [{ start: 0, emotion: 'neutral' }] };
  }

  // Build clean text and proportional timeline
  const cleanText = segments.map(s => s.text).join(' ');
  const totalLen = segments.reduce((sum, s) => sum + s.text.length, 0);
  const emotionTimeline = [];
  let charPos = 0;
  for (const seg of segments) {
    emotionTimeline.push({ start: totalLen > 0 ? charPos / totalLen : 0, emotion: seg.emotion });
    charPos += seg.text.length;
  }

  return { text: cleanText, emotion: segments[0].emotion, emotionTimeline };
}

/**
 * Route: Start a voice pipeline session.
 * Creates a session, gets the AI's opening greeting via Claude + TTS.
 *
 * body: { systemPrompt, openingInstruction }
 * returns: { sessionId, response, audioBase64, mimeType }
 */
app.post('/api/session/start', async (req, res) => {
  try {
    const { systemPrompt, openingInstruction, typedStudentName } = req.body;
    if (!systemPrompt) return res.status(400).json({ error: 'Missing systemPrompt' });

    const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
    const history = [{ role: 'user', content: openingInstruction || '[Session started. Introduce yourself in German.]' }];

    let responseText = await callClaude(systemPrompt, history);
    history.push({ role: 'assistant', content: responseText });

    // Build the allowed word set for vocabulary validation
    // Use server-side unit data (unitMap) for reliability — not the frontend POST body.
    const grammarConstraints = req.body.grammarConstraints || null;
    let allowedWordSet = null;
    {
      // Determine target unit and book from the opening instruction or cumulative data
      const cumulativeData = req.body.cumulativeData || null;
      const universalFillers = req.body.universalFillers || null;

      if (cumulativeData) {
        // Build from the cumulative data the frontend sent (may be truncated)
        allowedWordSet = buildAllowedWordSet(cumulativeData, universalFillers);
      } else {
        // Fallback: try to extract unit from system prompt
        const unitMatch = systemPrompt.match(/Unit (\d+|[BO]\d+)/);
        if (unitMatch) {
          const targetId = unitMatch[1];
          // Use the server's /api/cumulative endpoint logic to build vocab
          const book = /^B/.test(targetId) ? 'ID2B' : /^O/.test(targetId) ? 'ID2O' : 'ID1';
          try {
            const resp = await fetch(`http://localhost:${process.env.PORT || 3000}/api/cumulative/${targetId}?book=${book}`);
            const unitData = await resp.json();
            if (unitData._cumulative) {
              allowedWordSet = buildAllowedWordSet(unitData._cumulative, unitData.universal_fillers);
            }
          } catch (e) { /* ignore — validation will be skipped */ }
        }
      }

      // Verify fillers are in the allowed set (belt and suspenders)
      if (allowedWordSet) {
        for (const w of UNIVERSAL_FILLER_WORDS) allowedWordSet.allowed.add(w);
        console.log(`[VALIDATOR] Built word set: ${allowedWordSet.allowed.size} allowed, ${allowedWordSet.passiveSet.size} passive`);
        // Debug: check critical words
        const checks = ['toll', 'cool', 'schön', 'super', 'warm', 'kalt', 'pullover'];
        const results = checks.map(w => `${w}:${allowedWordSet.allowed.has(w) ? 'A' : allowedWordSet.passiveSet.has(w) ? 'P' : 'X'}`);
        console.log(`[VALIDATOR] Key words: ${results.join(', ')}`);
      }
    }

    voiceSessions.set(sessionId, {
      systemPrompt, history, startTime: Date.now(),
      typedStudentName: typedStudentName || null,
      confirmedName: null,
      fullTranscript: [],
      allowedWordSet,
      grammarConstraints,
    });

    // Validate with tags intact (validator ignores [BRACKETED] content)
    if (allowedWordSet) {
      responseText = await validateAndCorrect(responseText, voiceSessions.get(sessionId));
    }

    if (VERBOSE) {
      console.log(`\n${DIM}[DEBUG] System prompt (${systemPrompt.length} chars):${RESET}`);
      console.log(`${DIM}${systemPrompt.slice(0, 500)}...${RESET}\n`);
    }

    // Log raw response with emotion tags visible for debugging
    console.log(`[EMOTIONS] Raw: "${responseText}"`);

    // Parse emotion AFTER validation, right before TTS
    const { text: cleanText, emotion, emotionTimeline } = parseEmotion(responseText);

    const ttsResult = await textToSpeech(cleanText);

    res.json({ sessionId, response: cleanText, emotion, emotionTimeline, audioBase64: ttsResult.audioBase64, mimeType: ttsResult.mimeType });
  } catch (error) {
    console.error('[Session Start] Error:', error.message);
    res.status(500).json({ error: 'Failed to start session', details: error.message });
  }
});

/**
 * Route: Process one conversation turn (audio → transcript → Claude → TTS).
 * Accepts multipart form data with audio file.
 *
 * fields: audio (file), sessionId (string), directives (JSON string, optional)
 * returns: { transcript, response, audioBase64, mimeType }
 */
app.post('/api/conversation-turn', upload.single('audio'), async (req, res) => {
  const renamedPath = req.file ? req.file.path + '.webm' : null;
  try {
    const { sessionId } = req.body;
    const session = voiceSessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!req.file) return res.status(400).json({ error: 'No audio file' });

    // 1. Whisper STT
    const t0 = Date.now();
    fs.renameSync(req.file.path, renamedPath);
    console.log(`[STT] Audio file: ${renamedPath}, size: ${fs.statSync(renamedPath).size} bytes, mime: ${req.file.mimetype}`);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(renamedPath),
      model: 'whisper-1',
      language: 'de',
    });
    let transcript = transcription.text?.trim() || '';
    const t1 = Date.now();
    console.log(`[TIMING] STT: ${t1 - t0}ms`);

    // 1b. Name spelling correction: replace Whisper's phonetic guess with typed spelling
    // e.g., Whisper produces "Nico" but student typed "Niko" → rewrite before Claude sees it
    if (transcript && session.typedStudentName && !session.confirmedName) {
      const typed = session.typedStudentName;
      const namePatterns = [
        /ich hei[sß]e\s+([^\s.,!?]+)/i,
        /mein name ist\s+([^\s.,!?]+)/i,
      ];
      for (const pattern of namePatterns) {
        const match = transcript.match(pattern);
        if (match) {
          const whisperName = match[1];
          // Same first letter = approximate match → use typed spelling
          if (whisperName.charAt(0).toLowerCase() === typed.charAt(0).toLowerCase()) {
            transcript = transcript.replace(whisperName, typed);
            session.confirmedName = typed;
            console.log(`[Name] Whisper="${whisperName}" → typed="${typed}" (auto-corrected)`);
          } else {
            // Completely different → flag for clarification (handled by frontend directives)
            console.log(`[Name] Whisper="${whisperName}" vs typed="${typed}" (mismatch, needs clarification)`);
          }
          break;
        }
      }
    }

    // 2. Handle inaudible input
    if (!transcript) {
      const fallbackText = 'Ich höre dich nicht gut. Kannst du das nochmal sagen?';
      const fallbackTts = await textToSpeech(fallbackText);
      session.history.push({ role: 'user', content: '(inaudible)' });
      session.history.push({ role: 'assistant', content: fallbackText });
      session.fullTranscript?.push({ role: 'student', text: '(inaudible)' });
      session.fullTranscript?.push({ role: 'buddy', text: fallbackText });
      return res.json({ transcript: '', response: fallbackText, emotion: 'empathetic', emotionTimeline: [{ start: 0, emotion: 'empathetic' }], audioBase64: fallbackTts.audioBase64, mimeType: fallbackTts.mimeType });
    }

    // 3. Build user message with optional directives
    let userContent = transcript;
    const directives = req.body.directives ? JSON.parse(req.body.directives) : [];
    if (directives.length > 0) {
      const directiveBlock = directives.join('\n');
      userContent = directiveBlock + '\n\n' + transcript;
    }

    // 4. Call Claude
    // Always log directives — essential for conversation debugging
    if (directives.length > 0) {
      for (const d of directives) console.log(`${DIM}[DIRECTIVE] ${d.slice(0, 150)}${RESET}`);
    }
    session.history.push({ role: 'user', content: userContent });
    const t2 = Date.now();
    let responseText = await callClaude(session.systemPrompt, session.history);
    const t3 = Date.now();
    console.log(`[TIMING] Claude: ${t3 - t2}ms`);

    // Guard: if Claude echoed a [SYSTEM:] directive, strip it and re-generate
    if (responseText.includes('[SYSTEM:') || responseText.includes('[SYSTEM ')) {
      console.warn('[GUARD] Claude echoed a system directive — stripping and re-generating');
      responseText = responseText.replace(/\[SYSTEM[:\s][^\]]*\]/g, '').trim();
      if (!responseText || responseText.length < 5) {
        // Nothing left after stripping — re-generate
        session.history.push({ role: 'user', content: '[SYSTEM: Your previous response was invalid. Respond naturally in German with one short sentence.]' });
        responseText = await callClaude(session.systemPrompt, session.history);
        session.history.pop();
      }
    }

    session.history.push({ role: 'assistant', content: responseText });

    // Track full transcript for accurate feedback
    session.fullTranscript?.push({ role: 'student', text: transcript });

    // 4b. Validate with tags intact (validator ignores [BRACKETED] content)
    const tv0 = Date.now();
    responseText = await validateAndCorrect(responseText, session);
    const tv1 = Date.now();
    if (tv1 - tv0 > 500) console.log(`[TIMING] Validator: ${tv1 - tv0}ms`);

    // Log raw response with emotion tags visible for debugging
    console.log(`[EMOTIONS] Raw: "${responseText}"`);

    // Parse emotion AFTER validation, right before TTS
    const { text: cleanText, emotion, emotionTimeline } = parseEmotion(responseText);

    session.fullTranscript?.push({ role: 'buddy', text: cleanText });

    // 5. TTS
    const t4 = Date.now();
    const ttsResult = await textToSpeech(cleanText);
    const t5 = Date.now();
    console.log(`[TIMING] TTS: ${t5 - t4}ms | Total: ${t5 - t0}ms (STT: ${t1 - t0}ms, Claude+Validator: ${t4 - t2}ms, TTS: ${t5 - t4}ms) [emotions: ${emotionTimeline.map(e => e.emotion).join('→')}]`);

    res.json({ transcript, response: cleanText, emotion, emotionTimeline, audioBase64: ttsResult.audioBase64, mimeType: ttsResult.mimeType });
  } catch (error) {
    console.error('[Conversation Turn] Error:', error.message);
    res.status(500).json({ error: 'Pipeline failed', details: error.message });
  } finally {
    // Clean up temp audio file
    if (renamedPath && fs.existsSync(renamedPath)) fs.unlink(renamedPath, () => {});
    else if (req.file?.path && fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {});
  }
});

/**
 * Route: Directive-only prompt (no student audio).
 * Used for silent-student prompts, max-duration closing, name corrections.
 *
 * body: { sessionId, directives: string[] }
 * returns: { response, audioBase64, mimeType }
 */
app.post('/api/session/prompt', async (req, res) => {
  try {
    const { sessionId, directives = [] } = req.body;
    const session = voiceSessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const directiveText = directives.join('\n');
    session.history.push({ role: 'user', content: directiveText });

    let responseText = await callClaude(session.systemPrompt, session.history);
    session.history.push({ role: 'assistant', content: responseText });

    // Validate with tags intact (validator ignores [BRACKETED] content)
    responseText = await validateAndCorrect(responseText, session);

    // Log raw response with emotion tags visible for debugging
    console.log(`[EMOTIONS] Raw: "${responseText}"`);

    // Parse emotion AFTER validation, right before TTS
    const { text: cleanText, emotion, emotionTimeline } = parseEmotion(responseText);

    const ttsResult = await textToSpeech(cleanText);

    res.json({ response: cleanText, emotion, emotionTimeline, audioBase64: ttsResult.audioBase64, mimeType: ttsResult.mimeType });
  } catch (error) {
    console.error('[Session Prompt] Error:', error.message);
    res.status(500).json({ error: 'Prompt failed', details: error.message });
  }
});

/**
 * Route: Update session system prompt (e.g., name confirmation).
 *
 * body: { sessionId, promptAddition }
 */
app.post('/api/session/update-prompt', (req, res) => {
  const { sessionId, promptAddition } = req.body;
  const session = voiceSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.systemPrompt = promptAddition + '\n\n' + session.systemPrompt;
  res.json({ ok: true });
});

// ─── End Voice Pipeline ──────────────────────────────────────────────────────

/**
 * Route: Persona Generator
 * Maps a unit number to its chapter key, then randomly selects one of the
 * 5 options for each of the 31 traits.  Traits with value "-" are marked
 * unavailable so the AI can deflect naturally.
 *
 * body: { book: "ID1"|"ID2B"|"ID2O", chapter: <number> }
 * returns: { chapterKey, persona: { [trait]: string|null } }
 */

/** Map (book, chapter) → persona database key */
function getPersonaChapterKey(book, chapter) {
  if (book === 'ID1')  return `ID1_Ch${chapter}`;
  if (book === 'ID2B') return `ID2B_Ch${chapter}`;
  if (book === 'ID2O') return `ID2O_Ch${chapter}`;
  return null;
}

app.post('/api/persona', (req, res) => {
  const { book = 'ID1', chapter = 1 } = req.body;
  const chapterKey = getPersonaChapterKey(book, chapter);

  if (!chapterKey || !personaDatabase[chapterKey]) {
    // Fallback to the richest available chapter (ID1_Ch8) when chapter not yet in DB.
    // This silently degrades rather than erroring.
    const fallbackKey = 'ID1_Ch8';
    const fallbackTraits = personaDatabase[fallbackKey];
    if (!fallbackTraits) return res.status(404).json({ error: 'Persona database empty' });
    return res.json({ chapterKey: fallbackKey, persona: buildPersona(fallbackTraits) });
  }

  const traits = personaDatabase[chapterKey];
  res.json({ chapterKey, persona: buildPersona(traits) });
});

function buildPersona(traits) {
  const persona = {};
  for (const [trait, options] of Object.entries(traits)) {
    const pick = options[Math.floor(Math.random() * options.length)];
    persona[trait] = pick === '-' ? null : pick;
  }
  return persona;
}

// (Removed: /api/transcribe — replaced by /api/conversation-turn pipeline)

/**
 * Route: Feedback Generator (Component 8)
 * Analyzes student utterances against communicative goals from all loaded units
 * up to the current one and returns English-language feedback sentences.
 */
app.post('/api/feedback', async (req, res) => {
  try {
    const { utterances = [], unit = 1, sessionDurationMs = 0, minDurationMs = 3*60*1000, sessionId } = req.body;
    const MIN_THRESHOLD_MS = 0.6 * minDurationMs;
    if (sessionDurationMs < MIN_THRESHOLD_MS) {
      return res.json({ fallback: true });
    }

    // Collect goals from units 1..unit, most recent first
    const goalsByUnit = [];
    for (let u = Number(unit); u >= 1; u--) {
      const ud = unitMap[String(u)];
      const goals = ud?.communicative_functions?.goals || [];
      if (goals.length > 0) goalsByUnit.push({ unit: u, goals });
    }

    if (goalsByUnit.length === 0 || utterances.length === 0) {
      return res.json({ fallback: true });
    }

    // Use full transcript (both student AND buddy turns) if available
    const session = sessionId ? voiceSessions.get(sessionId) : null;
    const fullTranscript = session?.fullTranscript || [];
    let conversationText;
    if (fullTranscript.length > 0) {
      conversationText = fullTranscript
        .map(t => `${t.role === 'student' ? 'STUDENT' : 'BUDDY'}: ${t.text}`)
        .join('\n');
    } else {
      conversationText = utterances.filter(Boolean).map(u => `STUDENT: ${u}`).join('\n');
    }

    const goalsText = goalsByUnit
      .map(({ unit: u, goals }) => `Unit ${u}: ${goals.join('; ')}`)
      .join('\n');

    const prompt = `You are evaluating a German language conversation between a student and a buddy.
The student is at Unit ${unit}. Communicative goals from Units 1–${unit} (most recent first):
${goalsText}

Full conversation transcript from this session:
${conversationText}

CRITICAL: Only report goals the student ACTUALLY demonstrated in the transcript above.
Do NOT report goals just because they are listed for the student's unit level.
A goal is "demonstrated" only if the student said something that directly relates to it.
For example: if the goal is "talk about weather" but the conversation never mentioned weather, do NOT include it.

Identify 2–8 communicative goals the student clearly demonstrated. Translate each into English.
Respond ONLY with a valid JSON object:
{ "items": ["You were able to ...", "You were able to ..."] }`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    let items = [];
    try {
      const text = response.content?.[0]?.text || '';
      const cleaned = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      items = Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      try {
        const text = response.content?.[0]?.text || '';
        const m = text.match(/\[[\s\S]*?\]/);
        if (m) items = JSON.parse(m[0]);
      } catch { /* fallback */ }
    }
    items = items.filter(s => typeof s === 'string' && s.trim()).slice(0, 8);
    res.json({ items });
  } catch (err) {
    console.error('[Feedback] Error:', err.message);
    res.json({ fallback: true });
  }
});

/**
 * Route: Semantic Topic Classification (for Conversation Manager)
 * Uses GPT-4o-mini to classify which conversation topic an AI utterance
 * relates to. Called asynchronously after each AI turn — does not block
 * the conversation flow.
 *
 * body: {
 *   text: "Wie heißt du?",
 *   currentTopics: ["Vergleiche zwischen Personen und Orten"],
 *   reviewTopics: [{ chapter: "Ch1", topic: "der eigene Name" }, ...]
 * }
 * returns: { matchedTopics: ["der eigene Name"], pool: "review"|"current"|"none" }
 */
app.post('/api/classify-topic', async (req, res) => {
  const { text, currentTopics = [], reviewTopics = [] } = req.body;

  if (!text?.trim()) return res.json({ matchedTopics: [], pool: 'none' });

  // Build a numbered list with pool labels for the prompt
  const allTopics = [
    ...currentTopics.map(t => ({ name: t, pool: 'current' })),
    ...reviewTopics.map(t => ({ name: t.topic || t, pool: 'review' })),
  ];

  if (allTopics.length === 0) return res.json({ matchedTopics: [], pool: 'none' });

  const topicList = allTopics.map((t, i) => `${i + 1}. [${t.pool}] ${t.name}`).join('\n');

  const prompt = `You are classifying a German conversation utterance by topic.

Utterance: "${text}"

Which of these conversation topics does this utterance relate to? A topic matches if the utterance is about the same subject — not just if it contains the same words. For example, "Wie heißt du?" relates to "der eigene Name" even though the word "Name" doesn't appear.

Topics:
${topicList}

Respond ONLY with a JSON object (no markdown, no explanation):
{ "matchedIndices": [1], "primaryPool": "current" }

If no topic matches, respond:
{ "matchedIndices": [], "primaryPool": "none" }`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 80,
      messages: [{ role: 'user', content: prompt }],
    });

    let result = { matchedIndices: [], primaryPool: 'none' };
    try {
      const raw = (response.content?.[0]?.text || '')
        .replace(/```json|```/g, '').trim();
      result = JSON.parse(raw);
    } catch { /* parse failed — return none */ }

    const matchedTopics = (result.matchedIndices || [])
      .filter(i => i >= 1 && i <= allTopics.length)
      .map(i => allTopics[i - 1].name);

    const pool = result.primaryPool || 'none';

    // Always log topic classification — essential for debugging
    if (matchedTopics.length > 0) {
      console.log(`${DIM}[TOPIC] [${pool}] ${matchedTopics.join(', ')}${RESET}`);
    }

    res.json({ matchedTopics, pool });
  } catch (err) {
    console.error('[Topic Classification] Error:', err.message);
    res.json({ matchedTopics: [], pool: 'none' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// TEACHER INVITE SYSTEM — Generate student codes in bulk
// ══════════════════════════════════════════════════════════════════════════
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');

// Code generation charset (no ambiguous chars: 0/O/1/I/L removed)
const CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateRandomCode(initials) {
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += CODE_CHARSET[Math.floor(Math.random() * CODE_CHARSET.length)];
  }
  return `BD-${initials}-${suffix}`;
}

function getInitials(name) {
  const parts = name.trim().split(/\s+/);
  const first = (parts[0] || 'X')[0].toUpperCase();
  const last = parts.length > 1 ? (parts[parts.length - 1] || 'X')[0].toUpperCase() : 'X';
  return first + last;
}

// POST /api/invite/validate-teacher — Verify teacher code + email
app.post('/api/invite/validate-teacher', async (req, res) => {
  const { code, email } = req.body;
  if (!code || !email) {
    return res.status(400).json({ valid: false, error: 'Code and email are required' });
  }

  try {
    const sheets = await getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: ACCESS_SHEETS_ID,
      range: 'Access Codes!A2:I',
    });

    const rows = result.data.values || [];
    const codeLower = code.trim().toLowerCase();
    const rowIndex = rows.findIndex(r => (r[0] || '').toLowerCase() === codeLower);

    if (rowIndex === -1) {
      return res.json({ valid: false, error: 'Invalid access code' });
    }

    const row = rows[rowIndex];
    // A=Code, B=Type, C=Tool, D=Max Uses, E=Used, F=Created By, G=Assigned To, H=Email, I=Notes
    const type = (row[1] || '').toLowerCase().trim();
    if (!type.includes('teacher')) {
      return res.json({ valid: false, error: 'This is not a teacher code' });
    }

    const storedEmail = (row[7] || '').trim().toLowerCase();
    if (!storedEmail || storedEmail !== email.trim().toLowerCase()) {
      return res.json({ valid: false, error: 'Email does not match the code on file' });
    }

    const maxUses = parseInt(row[3]) || 0;
    const used = parseInt(row[4]) || 0;
    const assignedTo = row[6] || '';

    return res.json({
      valid: true,
      assignedTo,
      availableCredits: maxUses - used,
      maxCredits: maxUses,
      usedCredits: used,
    });
  } catch (err) {
    console.error('[INVITE] Teacher validation error:', err.message);
    return res.status(500).json({ valid: false, error: 'Server error — please try again' });
  }
});

// POST /api/invite/create-codes — Generate student codes and write to Google Sheet
app.post('/api/invite/create-codes', async (req, res) => {
  const { teacherCode, teacherEmail, students } = req.body;
  if (!teacherCode || !teacherEmail || !Array.isArray(students) || students.length === 0) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  try {
    const sheets = await getSheetsClient();

    // Re-validate teacher code + email
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: ACCESS_SHEETS_ID,
      range: 'Access Codes!A2:I',
    });

    const rows = result.data.values || [];
    const codeLower = teacherCode.trim().toLowerCase();
    const teacherRowIndex = rows.findIndex(r => (r[0] || '').toLowerCase() === codeLower);

    if (teacherRowIndex === -1) {
      return res.json({ success: false, error: 'Invalid teacher code' });
    }

    const teacherRow = rows[teacherRowIndex];
    const type = (teacherRow[1] || '').toLowerCase().trim();
    if (!type.includes('teacher')) {
      return res.json({ success: false, error: 'Not a teacher code' });
    }

    const storedEmail = (teacherRow[7] || '').trim().toLowerCase();
    if (!storedEmail || storedEmail !== teacherEmail.trim().toLowerCase()) {
      return res.json({ success: false, error: 'Email mismatch' });
    }

    const maxUses = parseInt(teacherRow[3]) || 0;
    const used = parseInt(teacherRow[4]) || 0;
    const availableCredits = maxUses - used;
    const teacherName = teacherRow[6] || 'Unknown Teacher';

    // Calculate total credits needed
    const totalCredits = students.reduce((sum, s) => sum + (parseInt(s.conversations) || 0), 0);
    if (totalCredits > availableCredits) {
      return res.json({
        success: false,
        error: `Not enough credits. Need ${totalCredits}, have ${availableCredits}.`,
      });
    }

    // Collect all existing codes for uniqueness check
    const existingCodes = new Set(rows.map(r => (r[0] || '').toLowerCase()));

    // Generate unique codes for each student
    const generatedCodes = [];
    for (const student of students) {
      const initials = getInitials(student.name || 'XX');
      let code;
      let attempts = 0;
      do {
        code = generateRandomCode(initials);
        attempts++;
        if (attempts > 100) throw new Error('Could not generate unique code after 100 attempts');
      } while (existingCodes.has(code.toLowerCase()));

      existingCodes.add(code.toLowerCase());
      generatedCodes.push({
        name: student.name,
        university: student.university || '',
        email: student.email || '',
        conversations: parseInt(student.conversations) || 1,
        code,
      });
    }

    // Deduct credits from teacher (update Used column)
    const teacherSheetRow = teacherRowIndex + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: ACCESS_SHEETS_ID,
      range: `Access Codes!E${teacherSheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[used + totalCredits]] },
    });

    // Append student rows to Access Codes sheet
    // A=Code, B=Type, C=Tool, D=Max Uses, E=Used, F=Created By, G=Assigned To, H=Email, I=Notes
    const newRows = generatedCodes.map(s => [
      s.code,
      'student',
      'Buddy',
      s.conversations,
      0,
      teacherName,
      `${s.name}${s.university ? ' (' + s.university + ')' : ''}`,
      s.email,
      `Created with teacher code "${teacherCode}"`,
    ]);

    // Use USER_ENTERED so the Tool column respects the dropdown data validation
    await sheets.spreadsheets.values.append({
      spreadsheetId: ACCESS_SHEETS_ID,
      range: 'Access Codes!A:I',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: newRows },
    });

    console.log(`[INVITE] Teacher "${teacherName}" (${teacherCode}) created ${generatedCodes.length} student codes, ${totalCredits} credits used`);

    return res.json({
      success: true,
      codes: generatedCodes,
      totalUsed: totalCredits,
      remaining: availableCredits - totalCredits,
    });
  } catch (err) {
    console.error('[INVITE] Create codes error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error — please try again' });
  }
});

// POST /api/invite/download-pdf — Generate printable cards PDF with QR codes
app.post('/api/invite/download-pdf', async (req, res) => {
  const { codes, teacherName } = req.body;
  if (!Array.isArray(codes) || codes.length === 0) {
    return res.status(400).json({ error: 'No codes provided' });
  }

  try {
    // Pre-generate all QR codes as PNG buffers
    const qrBuffers = await Promise.all(
      codes.map(s => QRCode.toBuffer('https://buddy.impulsdeutsch.com', {
        width: 120, margin: 1, color: { dark: '#008899', light: '#ffffff' },
      }))
    );

    const doc = new PDFDocument({ size: 'A4', margin: 36, autoFirstPage: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="student-codes.pdf"');
    doc.pipe(res);

    // Card dimensions: 2 columns × 4 rows on A4 (595 × 842 pt)
    const pageW = 595 - 72; // minus margins
    const cols = 2;
    const rowsPerPage = 4;
    const gapX = 12;
    const gapY = 8;
    const cardW = (pageW - gapX) / cols;
    const cardH = 175;
    const cardsPerPage = cols * rowsPerPage;
    const qrSize = 70;

    for (let i = 0; i < codes.length; i++) {
      if (i > 0 && i % cardsPerPage === 0) doc.addPage();

      const pageIndex = i % cardsPerPage;
      const col = pageIndex % cols;
      const row = Math.floor(pageIndex / cols);
      const x = 36 + col * (cardW + gapX);
      const y = 36 + row * (cardH + gapY);

      const s = codes[i];

      // Card border (dashed cut line)
      doc.save();
      doc.roundedRect(x, y, cardW, cardH, 6)
         .dash(4, { space: 3 })
         .stroke('#bbb');
      doc.undash();

      // Left content area (text), right area (QR)
      const textW = cardW - qrSize - 36;

      // Header
      doc.fontSize(8.5).fillColor('#008899').font('Helvetica-Bold')
         .text('Impuls Deutsch', x + 14, y + 12, { width: textW });
      doc.fontSize(7.5).fillColor('#64748b').font('Helvetica')
         .text('Conversation Buddy', x + 14, y + 23, { width: textW });

      // Student name
      doc.fontSize(12).fillColor('#1e293b').font('Helvetica-Bold')
         .text(s.name || 'Student', x + 14, y + 42, { width: textW });

      // Access code (large)
      doc.fontSize(20).fillColor('#008899').font('Helvetica-Bold')
         .text(s.code, x + 14, y + 62, { width: textW });

      // Conversations count
      doc.fontSize(9).fillColor('#475569').font('Helvetica')
         .text(`${s.conversations} conversation${s.conversations !== 1 ? 's' : ''}`, x + 14, y + 90, { width: textW });

      // Instructions
      doc.fontSize(7.5).fillColor('#94a3b8').font('Helvetica')
         .text('Go to the URL or scan the QR code,', x + 14, y + 112, { width: textW })
         .text('then enter your access code.', x + 14, y + 122, { width: textW });

      // URL
      doc.fontSize(8).fillColor('#008899').font('Helvetica-Bold')
         .text('buddy.impulsdeutsch.com', x + 14, y + 142, { width: textW });

      // QR code (right side)
      doc.image(qrBuffers[i], x + cardW - qrSize - 14, y + 14, { width: qrSize, height: qrSize });

      doc.restore();
    }

    doc.end();
  } catch (err) {
    console.error('[INVITE] PDF generation error:', err.message);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

// POST /api/invite/send-emails — Send invitation emails to students
app.post('/api/invite/send-emails', async (req, res) => {
  const { codes, teacherName } = req.body;
  if (!Array.isArray(codes) || codes.length === 0) {
    return res.status(400).json({ error: 'No codes provided' });
  }

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) {
    return res.status(500).json({ error: 'Email service is not configured' });
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: gmailUser, pass: gmailPass },
  });

  const studentsWithEmail = codes.filter(s => s.email && s.email.includes('@'));
  if (studentsWithEmail.length === 0) {
    return res.json({ sent: 0, failed: 0, error: 'No students with valid email addresses' });
  }

  const results = [];
  let sent = 0;
  let failed = 0;

  for (const s of studentsWithEmail) {
    try {
      await transporter.sendMail({
        from: `"Impuls Deutsch" <${gmailUser}>`,
        to: s.email,
        subject: 'Your Impuls Deutsch Conversation Buddy Access Code',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #008899; margin-bottom: 4px;">Impuls Deutsch</h2>
            <p style="color: #64748b; font-size: 14px; margin-top: 0;">Conversation Buddy</p>
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 16px 0;">
            <p>Hi <strong>${s.name}</strong>,</p>
            <p>${teacherName || 'Your teacher'} has invited you to practice German conversation using the Impuls Deutsch Conversation Buddy.</p>
            <div style="background: #f0fdfa; border: 2px solid #008899; border-radius: 8px; padding: 16px; margin: 20px 0; text-align: center;">
              <p style="color: #475569; margin: 0 0 4px 0; font-size: 13px;">Your Access Code</p>
              <p style="color: #008899; font-size: 28px; font-weight: bold; margin: 0; letter-spacing: 2px;">${s.code}</p>
            </div>
            <p>You have <strong>${s.conversations} conversation${s.conversations !== 1 ? 's' : ''}</strong> available.</p>
            <p>To get started:</p>
            <ol>
              <li>Go to <a href="https://buddy.impulsdeutsch.com" style="color: #008899;">buddy.impulsdeutsch.com</a></li>
              <li>Enter your access code</li>
              <li>Choose a unit and start practicing!</li>
            </ol>
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;">
            <p style="color: #94a3b8; font-size: 12px;">This is an automated message from the Impuls Deutsch AI Tools.</p>
          </div>
        `,
      });
      sent++;
      results.push({ name: s.name, email: s.email, status: 'sent' });
    } catch (err) {
      failed++;
      results.push({ name: s.name, email: s.email, status: 'failed', error: err.message });
      console.error(`[INVITE] Email failed for ${s.email}:`, err.message);
    }
  }

  console.log(`[INVITE] Emails sent: ${sent}, failed: ${failed}`);
  return res.json({ sent, failed, results });
});

// Serve the built React frontend (must come AFTER all API routes)
const distPath = path.join(__dirname, '../frontend/dist');
const landingPath = path.join(__dirname, '../landing');

// Host-based routing: impulsdeutsch.com (no subdomain) serves the landing page
// buddy.impulsdeutsch.com and localhost serve the buddy app
app.use((req, res, next) => {
  const host = req.hostname?.toLowerCase() || '';
  // Root domain without subdomain → landing page
  if (host === 'impulsdeutsch.com' || host === 'www.impulsdeutsch.com') {
    return express.static(landingPath)(req, res, () => {
      // If no static file matched, serve landing index.html
      res.sendFile(path.join(landingPath, 'index.html'));
    });
  }
  next();
});

// Serve invite page at /invite (before React catch-all)
const invitePath = path.join(__dirname, '../invite');
app.get('/invite', (req, res) => {
  res.sendFile(path.join(invitePath, 'index.html'));
});
app.use('/invite', express.static(invitePath));

app.use(express.static(distPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Loaded ${Object.keys(unitMap).length} units | Impuls Deutsch 1 | ${ID1_CHAPTERS.length} chapters`);

  // Pre-generate welcome instructions audio so first visitor gets it instantly
  const cacheKey = `Schedar:en-US:${WELCOME_INSTRUCTIONS_TEXT}`;
  if (!ttsCache.has(cacheKey)) {
    (async () => {
      try {
        const response = await googleAI.models.generateContent({
          model: 'gemini-2.5-pro-tts',
          contents: [{ role: 'user', parts: [{ text: `Say this in American English. Pronounce any German words or phrases naturally in German with a native German accent. Here is the text: ${WELCOME_INSTRUCTIONS_TEXT}` }] }],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Schedar' } },
              languageCode: 'en-US',
            },
          },
        });
        const audioPart = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        if (audioPart?.data) {
          const rawMime = audioPart.mimeType || '';
          if (rawMime.includes('L16') || rawMime.includes('pcm')) {
            const rateMatch = rawMime.match(/rate=(\d+)/);
            const sampleRate = rateMatch ? parseInt(rateMatch[1]) : 24000;
            const pcmBuffer = Buffer.from(audioPart.data, 'base64');
            const wavBuffer = wrapPcmInWav(pcmBuffer, sampleRate);
            ttsCache.set(cacheKey, { audioBase64: wavBuffer.toString('base64'), mimeType: 'audio/wav' });
          } else {
            ttsCache.set(cacheKey, { audioBase64: audioPart.data, mimeType: rawMime });
          }
          console.log('Welcome audio pre-generated and cached');
        }
      } catch (e) {
        console.warn('Welcome audio pre-generation failed:', e.message, '— will generate on first request');
      }
    })();
  }
});
