/**
 * Build export data from analysis state for PDF generation.
 * Extracted to a shared utility so both Header and Legend can use it.
 */
import { buildFormattedRanges } from './formatMap';

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

  const totalWords = analysisResult.sentences.flatMap(s => s.words).filter(w => w.type === 'word').length;
  const knownWords = analysisResult.sentences.flatMap(s => s.words).filter(w => w.type === 'word' && w.status === 'known').length;

  const unknownSet = new Set(unknownWords.map(w => w.toLowerCase()));
  const finalWords = finalText.trim().replace(/[.,!?;:"""„''()\[\]{}–—…]/g, '').split(/\s+/).filter(Boolean);
  const newTotal = finalWords.length;
  let newKnown = 0;
  let newTranslated = 0;
  for (const fw of finalWords) {
    if (!unknownSet.has(fw.toLowerCase())) newKnown++;
  }
  for (const [, mod] of Object.entries(wordModifications)) {
    if (mod.type === 'glossed') newTranslated++;
  }

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

  return {
    text: finalText.trim(),
    originalText: originalText.trim(),
    glossedWords,
    wordFormatting: wordFormatting || {},
    formattedRanges,
    title: 'Text Analysis',
    mode,
    annotations: mode === 'teacher' ? {
      unknownWords, replacedWords, grammarNotes, grammarChanges, vocabChanges, originalWordColors,
      readability: { percent: totalWords > 0 ? Math.round((knownWords / totalWords) * 100) : 100, knownWords, totalWords, grammarIssues: grammarNotes.length },
      newReadability: { percent: newTotal > 0 ? Math.round(((newKnown + newTranslated) / newTotal) * 100) : 100, knownWords: newKnown, totalWords: newTotal, translatedWords: newTranslated },
      selectedUnits: unitsList,
    } : undefined,
  };
}
