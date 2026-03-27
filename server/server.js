const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const multer = require('multer');
const OpenAI = require('openai');
const fs = require('fs');
const https = require('https');

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

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Middleware
app.use(cors());
app.use(express.json());

// Configure multer for audio file uploads
const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
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
    ? `Unit ${unitNumber} — ${(unitData.communicative_functions?.goals || [])[0] || (unitData.conversation_topics?.topics || [])[0] || ''}`
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
    console.log(`${time} ${BOLD}${BLUE}    AI :${RESET} ${text}`);
  }
  // NOTE: does NOT call broadcastLog — callers handle that themselves.
}

function logConversationEnd(sessionId, exchangeCount) {
  console.log(`${BOLD}${CYAN}${'─'.repeat(60)}${RESET}`);
  console.log(`${BOLD}${RED}[${timestamp()}] CONVERSATION ENDED${RESET}  ${DIM}session: ${sessionId} | ${exchangeCount} student turn(s)${RESET}`);
  console.log(`${BOLD}${CYAN}${'═'.repeat(60)}${RESET}\n`);
  broadcastLog({ type: 'end', sessionId, exchangeCount, time: timestamp() });
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

// Token endpoint for WebRTC Realtime API
app.get('/token', async (req, res) => {
  console.log('Token endpoint requested');
  try {
    const response = await new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: 'gpt-4o-realtime-preview-2024-12-17',
        voice: 'verse'
      });

      const options = {
        hostname: 'api.openai.com',
        port: 443,
        path: '/v1/realtime/sessions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': data.length
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        console.log('OpenAI response status:', res.statusCode);
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          console.log('OpenAI response body:', body);
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', (err) => {
        console.error('HTTPS request error:', err);
        reject(err);
      });
      req.write(data);
      req.end();
    });

    console.log('Session created successfully');
    res.json({ value: response.client_secret.value });
  } catch (error) {
    console.error('Error creating session token:', error);
    res.status(500).json({ error: 'Failed to create session token', details: error.message });
  }
});

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
      topic: (u.communicative_functions?.goals || [])[0]
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

  const cumulativeActiveVocab = [], cumulativePassiveVocab = [];
  const cumulativeVerbForms = {};
  const reviewTopics = [], reviewFunctions = [];
  const seenActive = new Set(), seenPassive = new Set();

  for (const uid of prerequisiteIds) {
    const u = unitMap[uid];
    if (!u) continue;
    const isOptional = u.is_optional || false;

    if (!isOptional) {
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

    if (uid !== targetId) {
      for (const topic of (u.conversation_topics?.topics || [])) { if (topic) reviewTopics.push({ unit: uid, topic }); }
      for (const goal of (u.communicative_functions?.goals || [])) { if (goal) reviewFunctions.push({ unit: uid, goal }); }
    }
  }

  // Sample review topics: up to 3 per chapter
  const chapterBuckets = {};
  const chapterList = ALL_CHAPTERS[book] || ID1_CHAPTERS;
  for (const { unit: uid, topic } of reviewTopics) {
    const u = unitMap[uid];
    const pos = u?.sequence_info?.position || parseInt(String(uid).replace(/^[BO]/i, ''));
    let chNum = 0;
    for (const ch of chapterList) { if (pos >= ch.unitStart && pos <= ch.unitEnd) { chNum = ch.chapter; break; } }
    const key = `Ch${chNum}`;
    if (!chapterBuckets[key]) chapterBuckets[key] = [];
    if (!chapterBuckets[key].includes(topic)) chapterBuckets[key].push(topic);
  }
  const sampledReviewTopics = [];
  for (const [ch, topics] of Object.entries(chapterBuckets).sort()) {
    for (const t of topics.slice(0, 3)) sampledReviewTopics.push({ chapter: ch, topic: t });
  }

  res.json({
    ...targetUnit,
    _cumulative: {
      activeVocabulary: cumulativeActiveVocab,
      passiveVocabulary: cumulativePassiveVocab,
      verbForms: cumulativeVerbForms,
      reviewTopics: sampledReviewTopics,
      reviewFunctions: reviewFunctions.slice(-30),
      stats: {
        totalActiveWords: cumulativeActiveVocab.length,
        totalPassiveWords: cumulativePassiveVocab.length,
        totalVerbs: Object.keys(cumulativeVerbForms).length,
        totalReviewTopics: sampledReviewTopics.length,
        prerequisiteUnits: prerequisiteIds.length,
      },
    },
  });
});

/**
 * Route: Start a new conversation
 */
app.post('/api/conversation/start', async (req, res) => {
  try {
    const { unitNumber } = req.body;
    
    if (!unitNumber || unitNumber < 1 || unitNumber > 104) {
      return res.status(400).json({ error: 'Invalid unit number' });
    }
    
    const conversationId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const systemPrompt = `Du bist ein freundlicher Gesprächspartner für Deutschlernende. Sprich einfach und klar. Beginne mit: "Hallo! Wie heißt du?"`;
    
    // Initialize conversation with system message
    const messages = [
      { role: 'system', content: systemPrompt }
    ];
    
    // Get initial AI greeting
    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: messages,
      temperature: 0.8,
      max_tokens: 100
    });
    
    const aiResponse = completion.choices[0].message.content;
    messages.push({ role: 'assistant', content: aiResponse });
    
    // Store conversation
    conversations.set(conversationId, {
      unitNumber,
      messages,
      createdAt: Date.now(),
      exchangeCount: 0
    });

    // Log conversation start
    logConversationStart(conversationId, unitNumber);
    logTurn('ai', aiResponse);
    
    res.json({
      conversationId,
      message: aiResponse
    });
    
  } catch (error) {
    console.error('Error starting conversation:', error);
    res.status(500).json({ error: 'Failed to start conversation' });
  }
});

/**
 * Route: Speech to text (transcription)
 */
app.post('/api/speech-to-text', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }
    
    // Transcribe audio using OpenAI Whisper
    // Rename file to have proper extension for OpenAI
    const audioPath = req.file.path;
    const renamedPath = audioPath + '.webm';
    fs.renameSync(audioPath, renamedPath);
    
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(renamedPath),
      model: 'gpt-4o-transcribe', // better accuracy than whisper-1 for short clips
      language: 'de', // German
    });
    
    // Clean up uploaded file
    if (fs.existsSync(renamedPath)) {
      fs.unlinkSync(renamedPath);
    }
    
    res.json({ text: transcription.text });
    
  } catch (error) {
    console.error('Error transcribing audio:', error);
    
    // Clean up file on error
    if (req.file) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      const cleanupPath = req.file.path + '.webm';
      if (fs.existsSync(cleanupPath)) {
        fs.unlinkSync(cleanupPath);
      }
    }
    
    res.status(500).json({ error: 'Failed to transcribe audio' });
  }
});

/**
 * Route: Process user message and get AI response
 */
app.post('/api/conversation/message', async (req, res) => {
  try {
    const { conversationId, message } = req.body;
    
    if (!conversationId || !message) {
      return res.status(400).json({ error: 'Missing conversationId or message' });
    }
    
    const conversation = conversations.get(conversationId);
    
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    // Log and add user message to conversation
    logTurn('student', message);
    conversation.messages.push({ role: 'user', content: message });
    conversation.exchangeCount = (conversation.exchangeCount || 0) + 1;
    
    // Get AI response
    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: conversation.messages,
      temperature: 0.8, // More natural, less robotic
      max_tokens: 100, // Shorter, more conversational responses
      presence_penalty: 0.6, // Encourage variety in responses
      frequency_penalty: 0.3 // Reduce repetition
    });
    
    const aiResponse = completion.choices[0].message.content;
    conversation.messages.push({ role: 'assistant', content: aiResponse });
    logTurn('ai', aiResponse);
    
    // Check if there's an image to display for this unit
    const image = getImageForResponse(conversation.unitNumber, aiResponse);
    
    const responseData = { response: aiResponse };
    if (image) {
      responseData.image = image;
    }
    
    res.json(responseData);
    
  } catch (error) {
    console.error('Error processing message:', error);
    res.status(500).json({ error: 'Failed to process message' });
  }
});

/**
 * Route: Text to speech
 */
app.post('/api/text-to-speech', async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'No text provided' });
    }
    
    // Generate speech using OpenAI TTS
    const mp3 = await openai.audio.speech.create({
      model: 'tts-1-hd', // HD model for better quality
      voice: 'onyx', // Deep, warm, very natural voice
      input: text,
      speed: 1.0, // Completely natural conversational pace
      response_format: 'mp3'
    });
    
    const buffer = Buffer.from(await mp3.arrayBuffer());
    
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': buffer.length
    });
    
    res.send(buffer);
    
  } catch (error) {
    console.error('Error generating speech:', error);
    res.status(500).json({ error: 'Failed to generate speech' });
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
      const lbl = ev.role === 'student' ? 'STUDENT' : '    AI';
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
    logSessions.set(sessionId, { unit, unitTitle, exchangeCount: 0 });
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
    if (!pending) logTurn(role, text);
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
    broadcastLog({ type: 'update-turn', id, text: updatedText, time: timestamp() });

  } else if (type === 'end') {
    const session = logSessions.get(sessionId);
    const count = session ? session.exchangeCount : 0;
    logConversationEnd(sessionId, count);
    logSessions.delete(sessionId);
  }

  res.json({ ok: true });
});

/**
 * Route: End conversation (cleanup)
 */
app.post('/api/conversation/end', (req, res) => {
  const { conversationId } = req.body;
  
  if (conversationId && conversations.has(conversationId)) {
    const conv = conversations.get(conversationId);
    logConversationEnd(conversationId, conv.exchangeCount || 0);
    conversations.delete(conversationId);
  }
  
  res.json({ success: true });
});

// Cleanup old conversations (every hour)
setInterval(() => {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1 hour
  
  for (const [id, conversation] of conversations.entries()) {
    if (now - conversation.createdAt > maxAge) {
      logConversationEnd(id, conversation.exchangeCount || 0);
      conversations.delete(id);
    }
  }
}, 60 * 60 * 1000);

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

/**
 * Route: Student audio transcription via Whisper
 * Receives a WebM audio blob from the frontend MediaRecorder and returns the transcript.
 */
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file' });
  // Multer saves the temp file without an extension; Whisper/gpt-4o-transcribe
  // uses the filename to detect format, so rename to add .webm before uploading.
  const renamedPath = req.file.path + '.webm';
  try {
    fs.renameSync(req.file.path, renamedPath);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(renamedPath),
      model: 'gpt-4o-transcribe',
      language: 'de',
    });
    res.json({ text: transcription.text || '' });
  } catch (err) {
    console.error('[Transcribe] Error:', err.message);
    res.json({ text: '' });
  } finally {
    if (fs.existsSync(renamedPath)) fs.unlink(renamedPath, () => {});
    else if (fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {});
  }
});

/**
 * Route: Feedback Generator (Component 8)
 * Analyzes student utterances against communicative goals from all loaded units
 * up to the current one and returns English-language feedback sentences.
 */
app.post('/api/feedback', async (req, res) => {
  try {
    const { utterances = [], unit = 1, sessionDurationMs = 0, minDurationMs = 3*60*1000 } = req.body;
    const MIN_THRESHOLD_MS = 0.6 * minDurationMs; // 60% of chapter minimum duration
    if (sessionDurationMs < MIN_THRESHOLD_MS) {
      return res.json({ fallback: true });
    }

    // Collect goals from units 1..unit, most recent first (higher-unit goals prioritized)
    const goalsByUnit = [];
    for (let u = Number(unit); u >= 1; u--) {
      const ud = unitMap[String(u)];
      const goals = ud?.communicative_functions?.goals || [];
      if (goals.length > 0) goalsByUnit.push({ unit: u, goals });
    }

    if (goalsByUnit.length === 0 || utterances.length === 0) {
      return res.json({ fallback: true });
    }

    const goalsText = goalsByUnit
      .map(({ unit: u, goals }) => `Unit ${u}: ${goals.join('; ')}`)
      .join('\n');
    const utterancesText = utterances.filter(Boolean).join('\n');

    const prompt =
`You are evaluating a German language student's spoken conversation.\nThe student is at Unit ${unit}. Communicative goals from Units 1\u2013${unit} (most recent first):\n${goalsText}\n\nStudent utterances from this session:\n${utterancesText}\n\nIdentify 2\u20138 communicative goals the student clearly demonstrated. Prioritize goals from higher-numbered (more recent) units. Translate each matched goal into an English phrase.\nRespond ONLY with a valid JSON object:\n{ "items": ["You were able to ...", "You were able to ..."] }`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 400,
    });

    let items = [];
    try {
      const parsed = JSON.parse(completion.choices[0].message.content);
      items = Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      const m = completion.choices[0].message.content.match(/\[[\s\S]*?\]/);
      if (m) items = JSON.parse(m[0]);
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
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 80,
    });

    let result = { matchedIndices: [], primaryPool: 'none' };
    try {
      const raw = completion.choices[0].message.content
        .replace(/```json|```/g, '').trim();
      result = JSON.parse(raw);
    } catch { /* parse failed — return none */ }

    const matchedTopics = (result.matchedIndices || [])
      .filter(i => i >= 1 && i <= allTopics.length)
      .map(i => allTopics[i - 1].name);

    const pool = result.primaryPool || 'none';

    res.json({ matchedTopics, pool });
  } catch (err) {
    console.error('[Topic Classification] Error:', err.message);
    res.json({ matchedTopics: [], pool: 'none' });
  }
});

// Serve the built React frontend (must come AFTER all API routes)
const distPath = path.join(__dirname, '../frontend/dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Loaded ${Object.keys(unitMap).length} units | Impuls Deutsch 1 | ${ID1_CHAPTERS.length} chapters`);
});
