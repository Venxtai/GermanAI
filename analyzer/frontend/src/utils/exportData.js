/**
 * Build export data from analysis state for PDF generation.
 * Extracted to a shared utility so both Header and Legend can use it.
 */
import { buildFormattedRanges } from './formatMap';
import { calculateReadability } from './readabilityCalc';

export function buildExportData(mode, { analysisResult, wordModifications, sentenceRewrites, selectedUnits, wordFormatting }) {
  const glossedWords = [];
  const unknownWords = [];
  const replacedWords = [];

  for (const [key, mod] of Object.entries(wordModifications)) {
    if (mod.type === 'glossed') {
      glossedWords.push({ word: mod.originalWord, translation: mod.translation || '' });
    } else if (mod.type === 'replaced') {
      replacedWords.push(mod.replacement);
    }
  }

  const originalWordColors = {};
  for (const sentence of analysisResult.sentences) {
    for (let wi = 0; wi < sentence.words.length; wi++) {
      const word = sentence.words[wi];
      if (word.type !== 'word') continue;
      const si = analysisResult.sentences.indexOf(sentence);
      const modKey = `${si}_${wi}`;
      const mod = wordModifications[modKey];
      const wLower = word.text.toLowerCase();

      if (mod?.type === 'glossed') {
        originalWordColors[wLower] = 'glossed';
      } else if (mod?.type === 'replaced' || mod?.type === 'marked_known') {
        originalWordColors[wLower] = 'known';
      } else if (word.status === 'unknown') {
        originalWordColors[wLower] = 'unknown';
        unknownWords.push(word.text);
      } else if (word.status === 'cognate') {
        originalWordColors[wLower] = 'cognate';
      } else {
        originalWordColors[wLower] = 'known';
      }
    }
  }

  let finalText = '';
  for (let si = 0; si < analysisResult.sentences.length; si++) {
    const sentence = analysisResult.sentences[si];
    const rewrite = sentenceRewrites[si];
    // Preserve paragraph breaks
    if (sentence.paragraphBreak) finalText += '\n';
    if (rewrite?.rewritten) {
      finalText += rewrite.rewritten + ' ';
    } else {
      for (const word of sentence.words) {
        const modKey = `${si}_${sentence.words.indexOf(word)}`;
        const mod = wordModifications[modKey];
        finalText += mod?.type === 'replaced' ? mod.replacement : word.text;
      }
      finalText += ' ';
    }
  }

  const grammarNotes = analysisResult.sentences
    .filter(s => s.grammar.status === 'issue')
    .map(s => ({
      sentence: s.text,
      issue: s.grammar.issues?.[0]?.description || 'Grammar issue detected',
      suggestion: s.grammar.issues?.[0]?.suggestion || '',
    }));

  let originalText = '';
  for (const sentence of analysisResult.sentences) {
    if (sentence.paragraphBreak) originalText += '\n';
    for (const word of sentence.words) originalText += word.text;
    originalText += ' ';
  }

  // Original readability: no modifications applied
  const origReadability = calculateReadability(analysisResult, {}, {});
  const totalWords = origReadability.totalWords;
  const knownWords = origReadability.knownWords + origReadability.cognateWords;

  // Adapted readability: with all modifications applied
  const adaptedReadability = calculateReadability(analysisResult, sentenceRewrites, wordModifications);
  const newTotal = adaptedReadability.totalWords;
  const newKnown = adaptedReadability.knownWords + adaptedReadability.cognateWords;
  const newTranslated = adaptedReadability.translatedWords;

  const vocabChanges = [];
  const grammarChanges = [];
  for (const [key, mod] of Object.entries(wordModifications)) {
    if (mod.type === 'replaced') {
      vocabChanges.push({ original: mod.originalWord, replacement: mod.replacement });
    } else if (mod.type === 'glossed') {
      vocabChanges.push({ original: mod.originalWord, replacement: mod.originalWord, explanation: 'translated for students', isGloss: true });
    }
  }
  for (const [si, rewrite] of Object.entries(sentenceRewrites)) {
    if (!rewrite?.changes) continue;
    const isWordReplacement = rewrite.targetStructure === 'word-replacement';
    for (const c of rewrite.changes) {
      if (isWordReplacement) vocabChanges.push({ original: c.original, replacement: c.replacement });
      else grammarChanges.push({ original: c.original, replacement: c.replacement, explanation: c.explanation });
    }
  }

  const id1Units = [], id2bUnits = [], id2oUnits = [];
  for (const uid of selectedUnits) {
    if (uid.startsWith('B')) id2bUnits.push(parseInt(uid.slice(1)));
    else if (uid.startsWith('O')) id2oUnits.push(parseInt(uid.slice(1)));
    else id1Units.push(parseInt(uid));
  }
  id1Units.sort((a, b) => a - b);
  id2bUnits.sort((a, b) => a - b);
  id2oUnits.sort((a, b) => a - b);
  const unitsLines = [];
  if (id1Units.length > 0) unitsLines.push(`Impuls Deutsch 1: ${id1Units.join(', ')}`);
  if (id2bUnits.length > 0) unitsLines.push(`Impuls Deutsch 2 BLAU: ${id2bUnits.join(', ')}`);
  if (id2oUnits.length > 0) unitsLines.push(`Impuls Deutsch 2 ORANGE: ${id2oUnits.join(', ')}`);
  const unitsList = unitsLines.join('\n');

  // Build formatted ranges for PDF export (character offset-based)
  const formattedRanges = buildFormattedRanges(wordFormatting, analysisResult.sentences);

  // Build a sequential word formatting list for the PDF renderer
  // This is more reliable than character offsets since the PDF splits text differently
  const wordFormattingList = [];
  for (let si = 0; si < analysisResult.sentences.length; si++) {
    const sentence = analysisResult.sentences[si];
    for (let wi = 0; wi < sentence.words.length; wi++) {
      const word = sentence.words[wi];
      if (word.type !== 'word') continue;
      const key = `${si}_${wi}`;
      const fmt = wordFormatting?.[key];
      wordFormattingList.push({
        text: word.text.toLowerCase(),
        bold: fmt?.bold || false,
        italic: fmt?.italic || false,
      });
    }
  }

  return {
    text: finalText.trim(),
    originalText: originalText.trim(),
    glossedWords,
    wordFormatting: wordFormatting || {},
    formattedRanges,
    wordFormattingList,
    title: 'Text Analysis',
    mode,
    annotations: mode === 'teacher' ? {
      unknownWords, replacedWords, grammarNotes, grammarChanges, vocabChanges, originalWordColors,
      readability: { percent: origReadability.percent, knownWords, totalWords, grammarIssues: grammarNotes.length },
      newReadability: { percent: adaptedReadability.percent, knownWords: newKnown, totalWords: newTotal, translatedWords: newTranslated },
      selectedUnits: unitsList,
    } : undefined,
  };
}
