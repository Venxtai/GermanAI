const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const multer = require('multer');
const OpenAI = require('openai');
const fs = require('fs');

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
app.use(express.static(path.join(__dirname, '../public')));

// Configure multer for audio file uploads
const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Load curriculum data
let curriculumData = {};
try {
  const curriculumPath = path.join(__dirname, '../curriculum/units.json');
  if (fs.existsSync(curriculumPath)) {
    curriculumData = JSON.parse(fs.readFileSync(curriculumPath, 'utf8'));
  }
} catch (error) {
  console.error('Error loading curriculum data:', error);
}

// Store active conversations (in production, use a database)
const conversations = new Map();

/**
 * Generate system prompt based on unit data
 */
function generateSystemPrompt(unitNumber) {
  const unit = curriculumData.units?.find(u => u.unit === unitNumber);
  
  if (!unit) {
    return `Du bist ein geduldiger Deutschlehrer. Sprich einfach und klar.`;
  }

  const vocabularyList = unit.vocabulary.join(', ');
  const phrasesList = unit.phrases.join('\n- ');
  const grammarRules = unit.grammar.join('\n- ');
  
  return `Du bist ein geduldiger und freundlicher Deutschlehrer für Anfänger.

WICHTIGE EINSCHRÄNKUNGEN:
Der Lernende ist in Einheit ${unitNumber}. Du DARFST NUR die folgenden sprachlichen Elemente verwenden:

ERLAUBTES VOKABULAR:
${vocabularyList}

ERLAUBTE SÄTZE/MUSTER:
- ${phrasesList}

GRAMMATIKREGELN:
- ${grammarRules}

VERHALTENSREGELN:
1. Verwende NUR Wörter und Strukturen aus dieser Einheit
2. Halte deine Antworten kurz (1-3 Sätze)
3. Sprich natürlich und freundlich
4. Stelle Fragen, um das Gespräch am Laufen zu halten
5. Korrigiere Fehler IMPLIZIT durch Wiederholung der richtigen Form
6. Verwende NIEMALS Vokabular oder Grammatik aus höheren Einheiten

KOMMUNIKATIONSZIELE dieser Einheit:
${unit.communicative_goals?.join(', ') || 'Grundlegende Kommunikation'}

Beginne das Gespräch mit einer einfachen Begrüßung oder Frage.`;
}

/**
 * Route: Get available units
 */
app.get('/api/units', (req, res) => {
  if (!curriculumData.units) {
    return res.json({ units: [] });
  }
  
  const unitsList = curriculumData.units.map(unit => ({
    unit: unit.unit,
    title: unit.title || `Einheit ${unit.unit}`,
    description: unit.description || ''
  }));
  
  res.json({ units: unitsList });
});

/**
 * Route: Get specific unit data
 */
app.get('/api/units/:unitNumber', (req, res) => {
  const unitNumber = parseInt(req.params.unitNumber);
  const unit = curriculumData.units?.find(u => u.unit === unitNumber);
  
  if (!unit) {
    return res.status(404).json({ error: 'Unit not found' });
  }
  
  res.json(unit);
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
    const systemPrompt = generateSystemPrompt(unitNumber);
    
    // Initialize conversation with system message
    const messages = [
      { role: 'system', content: systemPrompt }
    ];
    
    // Get initial AI greeting
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: messages,
      temperature: 0.7,
      max_tokens: 150
    });
    
    const aiResponse = completion.choices[0].message.content;
    messages.push({ role: 'assistant', content: aiResponse });
    
    // Store conversation
    conversations.set(conversationId, {
      unitNumber,
      messages,
      createdAt: Date.now()
    });
    
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
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: 'whisper-1',
      language: 'de' // German
    });
    
    // Clean up uploaded file
    fs.unlinkSync(req.file.path);
    
    res.json({ text: transcription.text });
    
  } catch (error) {
    console.error('Error transcribing audio:', error);
    
    // Clean up file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
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
    
    // Add user message to conversation
    conversation.messages.push({ role: 'user', content: message });
    
    // Get AI response
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: conversation.messages,
      temperature: 0.7,
      max_tokens: 150
    });
    
    const aiResponse = completion.choices[0].message.content;
    conversation.messages.push({ role: 'assistant', content: aiResponse });
    
    res.json({ response: aiResponse });
    
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
      model: 'tts-1',
      voice: 'nova', // Female voice, can be changed
      input: text,
      speed: 0.9 // Slightly slower for language learners
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

/**
 * Route: End conversation (cleanup)
 */
app.post('/api/conversation/end', (req, res) => {
  const { conversationId } = req.body;
  
  if (conversationId && conversations.has(conversationId)) {
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
      conversations.delete(id);
    }
  }
}, 60 * 60 * 1000);

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Curriculum data loaded: ${curriculumData.units?.length || 0} units`);
});
