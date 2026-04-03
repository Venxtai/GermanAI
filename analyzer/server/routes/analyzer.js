const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

// These get injected by server.js
let unitMap, vocabData, auth, unitNames;

function init(deps) {
  unitMap = deps.unitMap;
  vocabData = deps.vocabData;
  auth = deps.auth;
  unitNames = deps.unitNames || {};
}

// POST /api/auth/validate
router.post('/auth/validate', async (req, res) => {
  const result = await auth.validateCode(req.body.code);
  res.json(result);
});

// GET /api/chapters — Returns chapter hierarchy for all books
router.get('/chapters', (req, res) => {
  const { ALL_CHAPTERS } = require('../services/vocabIndex');
  const book = req.query.book;

  if (book && ALL_CHAPTERS[book]) {
    return res.json({ book, chapters: ALL_CHAPTERS[book] });
  }

  // Return all books with their chapters
  const result = {};
  for (const [bookId, chapters] of Object.entries(ALL_CHAPTERS)) {
    result[bookId] = {
      title: bookId === 'ID1' ? 'Impuls Deutsch 1' :
             bookId === 'ID2B' ? 'Impuls Deutsch 2 BLAU' :
             'Impuls Deutsch 2 ORANGE',
      chapters: chapters.map(ch => ({
        ...ch,
        units: getChapterUnits(bookId, ch),
      })),
    };
  }
  res.json(result);
});

// GET /api/units — Returns all units with metadata
router.get('/units', (req, res) => {
  const units = Object.entries(unitMap).map(([id, unit]) => ({
    id,
    track: unit.sequence_info?.track || 'core',
    position: unit.sequence_info?.position || 0,
    isOptional: unit.is_optional || false,
    topics: unit.conversation_topics?.topics || [],
    goals: unit.communicative_functions?.goals || [],
    vocabCount: (unit.active_vocabulary?.items || []).length,
  }));

  res.json(units);
});

// POST /api/analyzer/analyze — Full text analysis
router.post('/analyzer/analyze', async (req, res) => {
  const { text, selectedUnits } = req.body;

  if (!text || !selectedUnits || !Array.isArray(selectedUnits)) {
    return res.status(400).json({ error: 'Missing text or selectedUnits' });
  }

  const selectedUnitIds = new Set(selectedUnits.map(String));

  try {
    const { analyzeText } = require('../services/textAnalysis');
    const result = await analyzeText(text, selectedUnitIds, vocabData, unitMap);
    res.json(result);
  } catch (err) {
    console.error('[ANALYZE] Error:', err);
    res.status(500).json({ error: 'Analysis failed', message: err.message });
  }
});

// POST /api/analyzer/recheck — Lightweight re-check with different units (no AI calls)
// Used by What If mode for real-time re-coloring
router.post('/analyzer/recheck', (req, res) => {
  const { words, selectedUnits } = req.body;
  // words = array of { text, lemma } from the original analysis
  // selectedUnits = new unit selection to check against

  if (!words || !selectedUnits) {
    return res.status(400).json({ error: 'Missing words or selectedUnits' });
  }

  const { isWordKnown, findReplacements, getWordUnitInfo, normalizeWord } = require('../services/vocabIndex');
  const selectedUnitIds = new Set(selectedUnits.map(String));

  const results = words.map(w => {
    // Try surface form first
    let result = isWordKnown(
      w.text,
      selectedUnitIds,
      vocabData.vocabIndex,
      vocabData.verbFormIndex,
      vocabData.universalFillers,
    );

    // Try lemma if surface form not found
    if (!result.known && w.lemma && normalizeWord(w.lemma) !== normalizeWord(w.text)) {
      const lemmaResult = isWordKnown(
        w.lemma,
        selectedUnitIds,
        vocabData.vocabIndex,
        vocabData.verbFormIndex,
        vocabData.universalFillers,
      );
      if (lemmaResult.known) result = lemmaResult;
    }

    if (result.known) {
      return { status: 'known', reason: result.reason };
    }

    // Unknown — get unit info and replacements
    let unitInfo = getWordUnitInfo(w.text, Array.from(selectedUnitIds), Object.keys(unitMap), vocabData.vocabIndex);
    if (!unitInfo.inCurriculum && w.lemma) {
      unitInfo = getWordUnitInfo(w.lemma, Array.from(selectedUnitIds), Object.keys(unitMap), vocabData.vocabIndex);
    }

    const replacements = findReplacements(w.lemma || w.text, selectedUnitIds, vocabData.vocabIndex, vocabData.universalFillers);

    return { status: 'unknown', unitInfo, replacements };
  });

  // Compute readability
  const total = results.length;
  const known = results.filter(r => r.status === 'known').length;

  res.json({
    wordStatuses: results,
    readability: {
      percent: total > 0 ? Math.round((known / total) * 100) : 100,
      knownWords: known,
      totalWords: total,
    },
  });
});

// POST /api/analyzer/rewrite — Rewrite a sentence
router.post('/analyzer/rewrite', async (req, res) => {
  const { sentence, targetStructure, issueDescription, selectedUnits, priorReplacements } = req.body;

  if (!sentence || !targetStructure) {
    return res.status(400).json({ error: 'Missing sentence or targetStructure' });
  }

  const selectedUnitIds = new Set((selectedUnits || []).map(String));

  try {
    const { rewriteSentence } = require('../services/textAnalysis');
    const result = await rewriteSentence(sentence, targetStructure, issueDescription, selectedUnitIds, vocabData, priorReplacements);
    res.json(result);
  } catch (err) {
    console.error('[REWRITE] Error:', err);
    res.status(500).json({ error: 'Rewrite failed', message: err.message });
  }
});

// POST /api/analyzer/suggest — Get word replacement suggestions
router.post('/analyzer/suggest', (req, res) => {
  const { word, selectedUnits } = req.body;

  if (!word || !selectedUnits) {
    return res.status(400).json({ error: 'Missing word or selectedUnits' });
  }

  const { findReplacements } = require('../services/vocabIndex');
  const selectedUnitIds = new Set(selectedUnits.map(String));
  const suggestions = findReplacements(word, selectedUnitIds, vocabData.vocabIndex, vocabData.universalFillers);
  res.json({ suggestions });
});

// POST /api/analyzer/alternatives — Suggest replacement words/phrases from known vocab
router.post('/analyzer/alternatives', async (req, res) => {
  const { sentence, unknownWord, unknownLemma, selectedUnits, tryHarder } = req.body;

  if (!sentence || !unknownWord || !selectedUnits) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const selectedUnitIds = new Set(selectedUnits.map(String));

  // Build list of known active vocabulary with translations and POS
  const knownItems = [];
  const knownWordsSet = new Set();
  for (const uid of selectedUnitIds) {
    const unit = unitMap[uid];
    if (!unit?.active_vocabulary?.items) continue;
    for (const item of unit.active_vocabulary.items) {
      if (!knownWordsSet.has(item.word)) {
        knownWordsSet.add(item.word);
        knownItems.push({ word: item.word, pos: item.pos || '', translation: item.translation || '' });
      }
    }
  }

  // Look up the unknown word's translation and POS to help pre-filter
  const { lookupWord, normalizeWord } = require('../services/vocabIndex');
  const unknownLookup = lookupWord(unknownLemma || unknownWord, vocabData.vocabIndex, vocabData.verbFormIndex, vocabData.universalFillers);
  const unknownPos = unknownLookup.entries[0]?.pos || '';
  const unknownTranslation = unknownLookup.entries[0]?.translation || '';

  try {
    const { suggestWordAlternatives } = require('../services/textAnalysis');
    const alternatives = await suggestWordAlternatives(
      sentence, unknownWord, unknownLemma, knownItems, tryHarder, unknownPos, unknownTranslation,
    );
    res.json({ alternatives });
  } catch (err) {
    console.error('[ALTERNATIVES] Error:', err);
    res.status(500).json({ error: 'Failed', message: err.message });
  }
});

// POST /api/analyzer/apply-replacement — Replace a word and fix grammar
router.post('/analyzer/apply-replacement', async (req, res) => {
  const { sentence, originalWord, replacement } = req.body;

  if (!sentence || !originalWord || !replacement) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const { applyReplacementWithGrammar } = require('../services/textAnalysis');
    const result = await applyReplacementWithGrammar(sentence, originalWord, replacement);
    res.json(result);
  } catch (err) {
    console.error('[APPLY-REPLACE] Error:', err);
    res.status(500).json({ error: 'Failed', message: err.message });
  }
});

// GET /api/analyzer/example-sentences — Find all model sentences containing a word across ALL units
router.get('/analyzer/example-sentences', (req, res) => {
  const { word, pos } = req.query;
  if (!word) return res.status(400).json({ error: 'Missing word parameter' });

  const wordLower = word.toLowerCase();
  const posUpper = (pos || '').toUpperCase(); // VERB, NOUN, ADJ, ADV, etc.

  // Generate umlaut variants: a→ä, o→ö, u→ü, au→äu
  function umlautVariants(w) {
    const variants = [w];
    if (w.includes('a') && !w.includes('ä')) variants.push(w.replace(/a/, 'ä'));
    if (w.includes('o') && !w.includes('ö')) variants.push(w.replace(/o/, 'ö'));
    if (w.includes('u') && !w.includes('ü') && !w.includes('au')) variants.push(w.replace(/u/, 'ü'));
    if (w.includes('au')) variants.push(w.replace('au', 'äu'));
    if (w.includes('ä')) variants.push(w.replace(/ä/, 'a'));
    if (w.includes('ö')) variants.push(w.replace(/ö/, 'o'));
    if (w.includes('ü')) variants.push(w.replace(/ü/, 'u'));
    if (w.includes('äu')) variants.push(w.replace('äu', 'au'));
    return [...new Set(variants)];
  }

  const allForms = umlautVariants(wordLower);
  const escaped = allForms.map(f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // Capture the match and what's before it for POS filtering
  const wordRegex = new RegExp(`(?:^|[\\s.,!?;:""„''()\\[\\]{}–—…/])(?:${escaped})(?:s|es|n|en|er|e|em|ern)?(?=[\\s.,!?;:""„''()\\[\\]{}–—…/]|$)`, 'i');

  // Articles and determiners that indicate the next word is a noun
  // Includes contracted prepositions (im=in dem, beim=bei dem, zum=zu dem, vom=von dem, ans=an das, ins=in das)
  const articleSet = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'kein', 'keine', 'keinen', 'keinem', 'mein', 'meine', 'meinen', 'dein', 'deine', 'sein', 'seine', 'ihr', 'ihre', 'unser', 'unsere', 'euer', 'eure', 'im', 'am', 'ans', 'ins', 'vom', 'zum', 'zur', 'beim', 'fürs', 'ums', 'aufs', 'durchs', 'übers', 'unters', 'vors', 'hinters']);

  /**
   * POS-based filter: check if the matched word in the sentence is used
   * with the same POS as requested.
   * - VERB: exclude if preceded by an article (that would make it a noun, e.g. "das Essen")
   * - NOUN: exclude if NOT preceded by an article/adjective AND the word starts lowercase
   *         (lowercase without article = likely verb usage)
   */
  function matchesPOS(sent, matchedWord) {
    if (!posUpper) return true; // no POS filter

    const words = sent.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const clean = words[i].replace(/[.,!?;:""„''()\[\]{}–—…\/]/g, '');
      if (clean.toLowerCase() === matchedWord.toLowerCase() ||
          clean.toLowerCase().startsWith(matchedWord.toLowerCase())) {

        const prevWord = i > 0 ? words[i - 1].replace(/[.,!?;:""„''()\[\]{}–—…\/]/g, '').toLowerCase() : '';
        const isCapitalized = clean[0] === clean[0].toUpperCase();
        const prevIsArticle = articleSet.has(prevWord);

        if (posUpper === 'VERB') {
          // Verb: reject if preceded by article (= noun usage like "das Essen")
          if (prevIsArticle) return false;
          // Capitalized mid-sentence = almost certainly a noun in German
          // (verbs are only capitalized at sentence start)
          if (isCapitalized && i > 0) return false;
        }

        if (posUpper === 'NOUN') {
          // Noun: reject if lowercase and not after article (= likely verb usage)
          if (!isCapitalized && !prevIsArticle && i > 0) return false;
        }

        return true; // default: accept
      }
    }
    return true; // word not found in split (regex matched across boundaries) — accept
  }

  // Detect separable verb prefix for separated form matching
  const separablePrefixes = ['ab', 'an', 'auf', 'aus', 'bei', 'ein', 'mit', 'nach', 'vor', 'zu', 'zurück', 'zusammen', 'her', 'hin', 'um', 'weg', 'fest', 'los', 'teil', 'statt', 'kennen', 'fern'];
  let sepPrefix = null;
  let sepStem = null;
  if (posUpper === 'VERB') {
    for (const pf of separablePrefixes) {
      if (wordLower.startsWith(pf) && wordLower.length > pf.length + 2) {
        sepPrefix = pf;
        sepStem = wordLower.slice(pf.length); // e.g., "fernsehen" → "sehen"
        break;
      }
    }
  }

  const sentences = [];
  const seen = new Set();

  for (const [uid, unit] of Object.entries(unitMap)) {
    for (const sent of (unit.model_sentences?.literal || [])) {
      let matched = false;

      // Direct regex match
      if (wordRegex.test(sent)) {
        const match = sent.match(new RegExp(`(${escaped})`, 'i'));
        const matchedWord = match ? match[1] : wordLower;
        if (matchesPOS(sent, matchedWord)) {
          matched = true;
        }
      }

      // Separable verb: check for separated forms (e.g., "Ich sehe fern", "Ich sah fern")
      if (!matched && sepPrefix && sepStem) {
        const sentLower = sent.toLowerCase();
        const words = sent.split(/\s+/).map(w => w.replace(/[.,!?;:"""„''()\[\]{}–—…/]/g, ''));
        const wordsLower = words.map(w => w.toLowerCase());
        const prefixIdx = wordsLower.lastIndexOf(sepPrefix);
        if (prefixIdx >= 0) {
          for (let i = 0; i < prefixIdx; i++) {
            const w = wordsLower[i];
            // Simple stem match (handles regular conjugations)
            if (w.startsWith(sepStem.slice(0, Math.min(sepStem.length - 2, 4))) && w.length <= sepStem.length + 3) {
              matched = true;
              break;
            }
            // Use verb form index for irregular forms (e.g., sah → sehen)
            const { verbFormIndex } = vocabData;
            const forms = verbFormIndex?.get(w);
            if (forms?.some(f => f.lemma.toLowerCase() === sepStem || f.lemma.toLowerCase() === wordLower)) {
              matched = true;
              break;
            }
          }
        }
        // Perfekt: "habe ferngesehen", "hat eingekauft"
        const perfektWeak = sepPrefix + 'ge' + sepStem.replace(/en$/, 't');
        const perfektStrong = sepPrefix + 'ge' + sepStem;
        if (sentLower.includes(perfektWeak) || sentLower.includes(perfektStrong)) {
          matched = true;
        }
      }

      if (matched) {
        const key = sent + uid;
        if (!seen.has(key)) {
          seen.add(key);
          sentences.push({ sentence: sent, unitId: uid });
        }
      }
    }
  }

  res.json({ word, sentences });
});

// POST /api/analyzer/gloss — Generate contextual translation
router.post('/analyzer/gloss', async (req, res) => {
  const { word, sentenceContext } = req.body;

  if (!word) {
    return res.status(400).json({ error: 'Missing word' });
  }

  // Check if the word exists in the vocab index with a translation
  const { lookupWord, normalizeWord } = require('../services/vocabIndex');
  const lookup = lookupWord(word, vocabData.vocabIndex, vocabData.verbFormIndex, vocabData.universalFillers);
  const existingTranslation = lookup.entries.find(e => e.translation)?.translation;

  try {
    const { generateGloss } = require('../services/textAnalysis');
    const translation = await generateGloss(word, sentenceContext, existingTranslation);
    res.json({ word, translation, source: existingTranslation ? 'curriculum' : 'ai' });
  } catch (err) {
    console.error('[GLOSS] Error:', err);
    res.status(500).json({ error: 'Gloss generation failed', message: err.message });
  }
});

// GET /api/analyzer/lookup — Vocabulary lookup
router.get('/analyzer/lookup', (req, res) => {
  const { word } = req.query;

  if (!word) {
    return res.status(400).json({ error: 'Missing word parameter' });
  }

  const { lookupWord, formatFrequencyBand, getUnitBookAndChapter, normalizeWord } = require('../services/vocabIndex');
  const result = lookupWord(word, vocabData.vocabIndex, vocabData.verbFormIndex, vocabData.universalFillers);

  // Enrich entries with book/chapter info and frequency bands
  const enrichedEntries = result.entries.map(entry => ({
    ...entry,
    frequencyBand: formatFrequencyBand(entry.frequency),
    bookChapter: getUnitBookAndChapter(entry.unitId),
  }));

  res.json({
    word,
    normalizedWord: normalizeWord(word),
    isUniversalFiller: result.isUniversalFiller,
    entries: enrichedEntries,
    verbForms: result.verbForms,
  });
});

// POST /api/analyzer/upload — Parse uploaded file to text
router.post('/analyzer/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  let text = '';

  try {
    if (ext === '.txt') {
      text = fs.readFileSync(req.file.path, 'utf8');
    } else if (ext === '.pdf') {
      const pdfParse = require('pdf-parse');
      const buffer = fs.readFileSync(req.file.path);
      const data = await pdfParse(buffer);
      text = data.text;
    } else if (ext === '.docx') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: req.file.path });
      text = result.value;
    } else {
      return res.status(400).json({ error: `Unsupported file type: ${ext}. Use .txt, .pdf, or .docx` });
    }

    // Clean up temp file
    fs.unlinkSync(req.file.path);

    res.json({ text: text.trim(), filename: req.file.originalname });
  } catch (err) {
    // Clean up temp file on error
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    console.error('[UPLOAD] Parse error:', err);
    res.status(500).json({ error: 'File parsing failed', message: err.message });
  }
});

// POST /api/analyzer/export — Generate PDF export (student or teacher version)
router.post('/analyzer/export', async (req, res) => {
  const { text, originalText, glossedWords, title, mode, annotations } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Missing text' });
  }

  const exportMode = mode || 'student';

  try {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50, size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 }, bufferPages: true });

    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/pdf');
      const filename = exportMode === 'teacher'
        ? `${title || 'text-analysis'}-teacher.pdf`
        : `${title || 'text-analysis'}-student.pdf`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(pdfBuffer);
    });

    // Glossary map
    const glossMap = new Map();
    if (glossedWords && Array.isArray(glossedWords)) {
      for (const gw of glossedWords) glossMap.set(gw.word.toLowerCase(), gw.translation);
    }

    // Track pages for footer rendering
    let pageCount = 1;
    doc.on('pageAdded', () => pageCount++);

    // ─── HEADER ───
    if (exportMode === 'teacher') {
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#000')
        .text('Impuls Deutsch Text Analyser', { align: 'center' });
      doc.fontSize(10).font('Helvetica').fillColor('#000')
        .text('Teacher Version with Annotations', { align: 'center' });
    } else {
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#000')
        .text('Impuls Deutsch Text Analyser', { align: 'center' });
      doc.fontSize(10).font('Helvetica').fillColor('#888')
        .text('Student Version', { align: 'center' });
    }
    doc.fillColor('#000');

    if (exportMode === 'teacher') {
      // ═══════════════════════════════════════════════════
      // TEACHER VERSION LAYOUT — Side-by-side table
      // ═══════════════════════════════════════════════════

      const L = 50;        // left margin
      const CW = 237;      // column width
      const G = 20;        // gutter
      const R = L + CW + G; // right column start
      const PR = 545;      // page right

      // Base colors from analysis
      const baseColors = annotations?.originalWordColors || {};
      // Original text color: glossed words were unknown → show red in original
      function origBaseColor(clean) {
        const status = baseColors[clean];
        if (status === 'unknown' || status === 'glossed') return '#ef4444';
        return '#008899'; // known = teal
      }
      // Adapted text color: glossed → grey, unknown → red, known → teal
      function adaptedBaseColor(clean) {
        const status = baseColors[clean];
        if (status === 'glossed') return '#9ca3af';
        if (status === 'unknown') return '#ef4444';
        return '#008899';
      }

      // Override sets for grammar/vocab changes
      // In ORIGINAL text: words from changes tables are forced red
      const forceRedOriginal = new Set();
      for (const gc of (annotations?.grammarChanges || [])) {
        if (gc.original) for (const w of gc.original.toLowerCase().split(/\s+/)) forceRedOriginal.add(w);
      }
      for (const vc of (annotations?.vocabChanges || [])) {
        if (vc.original && !vc.isGloss) for (const w of vc.original.toLowerCase().split(/\s+/)) forceRedOriginal.add(w);
      }

      // In ADAPTED text: replacement words from changes are forced blue
      const forceBlueAdapted = new Set();
      for (const gc of (annotations?.grammarChanges || [])) {
        if (gc.replacement) for (const w of gc.replacement.toLowerCase().split(/\s+/)) forceBlueAdapted.add(w);
      }
      for (const vc of (annotations?.vocabChanges || [])) {
        if (vc.replacement && !vc.isGloss) for (const w of vc.replacement.toLowerCase().split(/\s+/)) forceBlueAdapted.add(w);
      }
      // Glossed words are grey in adapted text
      const forceGreyAdapted = new Set();
      for (const vc of (annotations?.vocabChanges || [])) {
        if (vc.isGloss) forceGreyAdapted.add((vc.original || '').toLowerCase());
      }

      // Units selected (multi-line, grouped by book, numbers aligned)
      if (annotations?.selectedUnits) {
        doc.moveDown(0.5);
        doc.fontSize(8).fillColor('#000');
        const unitsLines = annotations.selectedUnits.split('\n');
        const numCol = 195; // x position where numbers start (aligned across all lines)
        for (const line of unitsLines) {
          const colonIdx = line.indexOf(':');
          if (colonIdx > -1) {
            const label = line.substring(0, colonIdx + 1);
            const numbers = line.substring(colonIdx + 1).trim();
            const rowY = doc.y;
            doc.font('Helvetica-Bold').text(label, 50, rowY, { width: 140, lineBreak: false });
            doc.font('Helvetica').text(numbers, numCol, rowY, { width: PR - numCol });
            // doc.y is now after the numbers (which may wrap)
          } else {
            doc.font('Helvetica').text(line, 50);
          }
        }
        doc.fillColor('#000');
        doc.moveDown(3);
      }

      // ─── ROW 1: Column headings ───
      doc.moveDown(0.8);
      doc.fontSize(11).font('Helvetica-Bold');
      doc.text('Original Text', L, doc.y, { width: CW });
      const headY = doc.y - doc.currentLineHeight();
      doc.text('Adapted Text', R, headY, { width: CW });
      const lineY = Math.max(doc.y, headY + doc.currentLineHeight()) + 2;
      doc.moveTo(L, lineY).lineTo(L + CW, lineY).stroke('#008899');
      doc.moveTo(R, lineY).lineTo(R + CW, lineY).stroke('#008899');
      doc.y = lineY + 6;

      // ─── ROW 2: Texts side by side ───
      doc.fontSize(9).font('Helvetica');
      const textStartY = doc.y;

      // LEFT: Original text — base colors from analysis, overridden by changes tables
      const origWords = (originalText || text).split(/(\s+)/);
      doc.y = textStartY;
      for (const word of origWords) {
        const clean = word.replace(/[.,!?;:"""'\u201C\u201D\u201E\u2018\u2019()\[\]{}–\u2014…\/]/g, '').toLowerCase();
        if (forceRedOriginal.has(clean)) {
          doc.fillColor('#ef4444');
        } else {
          doc.fillColor(origBaseColor(clean));
        }
        doc.text(word, L, doc.y, { continued: true, width: CW });
      }
      doc.fillColor('#000').text('', L, doc.y, { width: CW });
      const leftEndY = doc.y;

      // RIGHT: Adapted text — blue for replacements, grey for glossed (with footnotes), black for rest
      const footnotes = [];
      let footnoteNum = 0;
      doc.y = textStartY;
      const adaptedWords = text.split(/(\s+)/);
      for (const word of adaptedWords) {
        const clean = word.replace(/[.,!?;:"""'\u201C\u201D\u201E\u2018\u2019()\[\]{}–\u2014…\/]/g, '').toLowerCase();
        if (forceGreyAdapted.has(clean) && glossMap.has(clean)) {
          footnoteNum++;
          footnotes.push({ num: footnoteNum, word: word.replace(/[.,!?;:]/g, ''), translation: glossMap.get(clean) });
          doc.fillColor('#9ca3af').text(word, R, doc.y, { continued: true, width: CW });
          doc.fontSize(7).fillColor('#666').text(`${footnoteNum}`, { continued: true, rise: 3 });
          doc.fontSize(9);
        } else if (forceBlueAdapted.has(clean)) {
          doc.fillColor('#3b82f6').text(word, R, doc.y, { continued: true, width: CW });
        } else {
          doc.fillColor(adaptedBaseColor(clean)).text(word, R, doc.y, { continued: true, width: CW });
        }
      }
      doc.fillColor('#000').text('', R, doc.y, { width: CW });
      const rightEndY = doc.y;

      // Glossary under adapted text (empty line, superscript numbers, no title)
      let glossEndY = rightEndY;
      if (footnotes.length > 0) {
        doc.y = rightEndY + 16; // empty line
        doc.fontSize(7).font('Helvetica').fillColor('#666');
        for (const fn of footnotes) {
          // Superscript number then word - translation
          doc.fontSize(6).text(`${fn.num}`, R, doc.y, { continued: true, rise: 3 });
          doc.fontSize(7).text(` ${fn.word} - ${fn.translation}`, { continued: false });
        }
        doc.fillColor('#000');
        glossEndY = doc.y;
      }

      doc.y = Math.max(leftEndY, glossEndY) + 10;

      // ─── ROW 3: Readability side by side ───
      doc.moveTo(L, doc.y).lineTo(L + CW, doc.y).stroke('#ddd');
      doc.moveTo(R, doc.y).lineTo(R + CW, doc.y).stroke('#ddd');
      doc.y += 6;
      const readY = doc.y;
      doc.fontSize(8).font('Helvetica');

      if (annotations?.readability) {
        const r = annotations.readability;
        doc.font('Helvetica-Bold').text('Original Readability', L, readY, { width: CW });
        doc.font('Helvetica').text(`${r.percent}% known (${r.knownWords}/${r.totalWords})`, L, doc.y, { width: CW });
        doc.text(`${r.grammarIssues} grammar issue${r.grammarIssues !== 1 ? 's' : ''}`, L, doc.y, { width: CW });
      }
      const leftReadEnd = doc.y;

      if (annotations?.newReadability) {
        const nr = annotations.newReadability;
        doc.font('Helvetica-Bold').text('Adapted Readability', R, readY, { width: CW });
        doc.font('Helvetica').text(`${nr.percent}% known (${nr.knownWords}/${nr.totalWords})`, R, doc.y, { width: CW });
        doc.text('0 grammar issues', R, doc.y, { width: CW });
      }
      doc.y = Math.max(leftReadEnd, doc.y) + 16;

      // ─── GRAMMAR CHANGES (3 cols: narrow | narrow | wide) ───
      const c1 = L, c1w = 90, c2 = L + 95, c2w = 90, c3 = L + 190, c3w = 305;
      if (annotations?.grammarChanges?.length > 0) {
        doc.moveTo(L, doc.y).lineTo(PR, doc.y).stroke('#ddd');
        doc.y += 8;
        doc.fontSize(10).font('Helvetica-Bold').text('Grammar Changes', L, doc.y);
        doc.moveDown(0.3);
        doc.fontSize(8).font('Helvetica');
        for (const gc of annotations.grammarChanges) {
          const rowY = doc.y;
          doc.fillColor('#ef4444').text(gc.original || '', c1, rowY, { width: c1w });
          const afterOrigY = doc.y;
          doc.fillColor('#3b82f6').text(gc.replacement || '', c2, rowY, { width: c2w });
          const afterReplY = doc.y;
          doc.fillColor('#888').text(gc.explanation || '', c3, rowY, { width: c3w });
          const afterExplY = doc.y;
          doc.y = Math.max(afterOrigY, afterReplY, afterExplY) + 4;
          doc.fillColor('#000');
        }
      }

      // ─── VOCABULARY CHANGES (3 cols: narrow | narrow | wide) ───
      if (annotations?.vocabChanges?.length > 0) {
        doc.y += 6;
        doc.moveTo(L, doc.y).lineTo(PR, doc.y).stroke('#ddd');
        doc.y += 8;
        doc.fontSize(10).font('Helvetica-Bold').text('Vocabulary Changes', L, doc.y);
        doc.moveDown(0.3);
        doc.fontSize(8).font('Helvetica');
        for (const vc of annotations.vocabChanges) {
          const rowY = doc.y;
          doc.fillColor(vc.isGloss ? '#ef4444' : '#ef4444').text(vc.original || '', c1, rowY, { width: c1w });
          const afterOrigY = doc.y;
          doc.fillColor(vc.isGloss ? '#9ca3af' : '#3b82f6').text(vc.replacement || '', c2, rowY, { width: c2w });
          const afterReplY = doc.y;
          doc.fillColor('#888').text(vc.explanation || '', c3, rowY, { width: c3w });
          const afterExplY = doc.y;
          doc.y = Math.max(afterOrigY, afterReplY, afterExplY) + 4;
          doc.fillColor('#000');
        }
      }

      // Footer is handled automatically on every page

    } else {
      // ═══════════════════════════════════════════════════
      // STUDENT VERSION LAYOUT
      // ═══════════════════════════════════════════════════
      doc.moveDown(1);
      doc.fontSize(12).font('Helvetica');

      const footnotes = [];
      let footnoteNum = 0;
      const words = text.split(/(\s+)/);
      for (const word of words) {
        const clean = word.replace(/[.,!?;:"""„''()\[\]{}–—…]/g, '').toLowerCase();
        if (glossMap.has(clean)) {
          footnoteNum++;
          footnotes.push({ num: footnoteNum, word: word.replace(/[.,!?;:]/g, ''), translation: glossMap.get(clean) });
          doc.text(word, { continued: true });
          doc.fontSize(8).text(`${footnoteNum}`, { continued: true, rise: 4 });
          doc.fontSize(12);
        } else {
          doc.text(word, { continued: true });
        }
      }
      doc.text('');

      if (footnotes.length > 0) {
        doc.moveDown(1.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ddd');
        doc.moveDown(0.5);
        doc.fontSize(12).font('Helvetica-Bold').text('Glossary');
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica');
        for (const fn of footnotes) {
          doc.text(`${fn.num}. ${fn.word} — ${fn.translation}`);
        }
      }

      // Footer is handled automatically on every page
    }

    // Add color legend footer to every page (using buffered pages)
    const footerY = doc.page.height - 35;
    const pages = doc.bufferedPageRange();
    for (let i = pages.start; i < pages.start + pages.count; i++) {
      doc.switchToPage(i);
      if (exportMode === 'teacher') {
        doc.fontSize(7).font('Helvetica');
        let xPos = 50;
        doc.fillColor('#008899').text('Known', xPos, footerY, { lineBreak: false }); xPos += 34;
        doc.fillColor('#ef4444').text('Unknown', xPos, footerY, { lineBreak: false }); xPos += 44;
        doc.fillColor('#3b82f6').text('Replaced', xPos, footerY, { lineBreak: false }); xPos += 48;
        doc.fillColor('#9ca3af').text('Glossed', xPos, footerY, { lineBreak: false });
      }
      doc.fillColor('#000');
    }

    doc.flushPages();
    doc.end();
  } catch (err) {
    console.error('[EXPORT] Error:', err);
    res.status(500).json({ error: 'Export failed', message: err.message });
  }
});

/**
 * Helper: get units belonging to a chapter in a specific book.
 */
function getChapterUnits(bookId, chapter) {
  const units = [];
  for (let pos = chapter.unitStart; pos <= chapter.unitEnd; pos++) {
    // Try both padded and unpadded IDs since JSON files may use either format
    let candidates;
    if (bookId === 'ID1') candidates = [String(pos)];
    else if (bookId === 'ID2B') candidates = [`B${pos}`, `B${String(pos).padStart(2, '0')}`];
    else if (bookId === 'ID2O') candidates = [`O${pos}`, `O${String(pos).padStart(2, '0')}`];
    else candidates = [String(pos)];

    const uid = candidates.find(c => unitMap[c]) || candidates[0];
    const unit = unitMap[uid];
    if (unit) {
      units.push({
        id: uid,
        position: pos,
        name: unitNames[uid] || unitNames[uid.replace(/^([BO])0*/, '$1')] || '',
        isOptional: unit.is_optional || false,
        topics: (unit.conversation_topics?.topics || []).slice(0, 2),
        vocabCount: (unit.active_vocabulary?.items || []).length,
      });
    }
  }
  return units;
}

// ═══════════════════════════════════════════════════════════════════
// SESSION TRACKING — Drive uploads for original + adapted PDFs
// ═══════════════════════════════════════════════════════════════════

// In-memory session store: sessionId -> { originalFileId, adaptedFileId, lastActivity }
const sessions = new Map();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Clean up expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      console.log(`[SESSION] Timeout for ${sid} — auto-saving`);
      // The adapted PDF should already be uploaded (frontend sends it on changes)
      sessions.delete(sid);
    }
  }
}, 60 * 1000); // check every minute

// POST /api/session/upload-original — Upload original text as PDF when Analyze is clicked
router.post('/session/upload-original', async (req, res) => {
  const { sessionId, pdfBase64, filename } = req.body;
  if (!sessionId || !pdfBase64) {
    return res.status(400).json({ error: 'Missing sessionId or pdfBase64' });
  }

  const pdfBuffer = Buffer.from(pdfBase64, 'base64');
  const result = await auth.uploadPdfToDrive(pdfBuffer, filename || `original_${sessionId}.pdf`);

  if (result) {
    // Track in session
    if (!sessions.has(sessionId)) sessions.set(sessionId, { lastActivity: Date.now() });
    sessions.get(sessionId).originalFileId = result.fileId;
    sessions.get(sessionId).lastActivity = Date.now();

    // Update Text Usage Log
    await auth.updateTextUsageLog(sessionId, 'original', result.link);
    res.json({ ok: true, link: result.link });
  } else {
    res.json({ ok: false, error: 'Upload failed' });
  }
});

// POST /api/session/upload-adapted — Upload/update adapted text PDF
router.post('/session/upload-adapted', async (req, res) => {
  const { sessionId, pdfBase64, filename } = req.body;
  if (!sessionId || !pdfBase64) {
    return res.status(400).json({ error: 'Missing sessionId or pdfBase64' });
  }

  const pdfBuffer = Buffer.from(pdfBase64, 'base64');

  // Check if we already have an adapted file for this session — update it
  const session = sessions.get(sessionId);
  if (session?.adaptedFileId) {
    const updated = await auth.updatePdfOnDrive(session.adaptedFileId, pdfBuffer);
    if (updated) {
      session.lastActivity = Date.now();
      return res.json({ ok: true, updated: true });
    }
  }

  // First upload (or update failed) — create new file
  const result = await auth.uploadPdfToDrive(pdfBuffer, filename || `adapted_${sessionId}.pdf`);
  if (result) {
    if (!sessions.has(sessionId)) sessions.set(sessionId, { lastActivity: Date.now() });
    sessions.get(sessionId).adaptedFileId = result.fileId;
    sessions.get(sessionId).lastActivity = Date.now();

    await auth.updateTextUsageLog(sessionId, 'adapted', result.link);
    res.json({ ok: true, link: result.link });
  } else {
    res.json({ ok: false, error: 'Upload failed' });
  }
});

// POST /api/session/heartbeat — Keep session alive
router.post('/session/heartbeat', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId && sessions.has(sessionId)) {
    sessions.get(sessionId).lastActivity = Date.now();
  }
  res.json({ ok: true });
});

module.exports = { router, init };
