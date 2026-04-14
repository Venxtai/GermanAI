import { useEffect, useRef } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';

/**
 * Auto-saves the adapted text PDF to Google Drive:
 * - Debounced: waits 10s after last change before uploading
 * - On page close (beforeunload): sends a sync beacon
 * - Uses the Legend's buildExportData logic to generate the teacher PDF
 */
export default function useAutoSave() {
  const {
    analysisResult, sessionId, wordModifications, sentenceRewrites, selectedUnits,
  } = useAnalyzerStore();

  const timerRef = useRef(null);
  const lastSaveRef = useRef(null); // track what was last saved to avoid duplicates

  // Build a fingerprint of current state to detect changes
  const stateFingerprint = analysisResult
    ? JSON.stringify({ mods: wordModifications, rewrites: sentenceRewrites })
    : null;

  useEffect(() => {
    if (!analysisResult || !sessionId || !stateFingerprint) return;

    // Skip if nothing changed since last save
    if (stateFingerprint === lastSaveRef.current) return;

    // Debounce: wait 10 seconds after last change
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      try {
        await uploadAdaptedPdf();
        lastSaveRef.current = stateFingerprint;
      } catch (err) {
        console.warn('Auto-save failed:', err);
      }
    }, 10000);

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [stateFingerprint, sessionId]);

  // Upload on page close
  useEffect(() => {
    if (!sessionId || !analysisResult) return;

    const handleBeforeUnload = () => {
      // Use sendBeacon for reliable delivery on page close
      // We need to build the PDF server-side, so send a trigger
      const payload = JSON.stringify({ sessionId, trigger: 'close' });
      navigator.sendBeacon('/api/session/heartbeat', new Blob([payload], { type: 'application/json' }));

      // Also try a sync upload if we have unsaved changes
      if (stateFingerprint !== lastSaveRef.current) {
        // Can't do async in beforeunload, but the heartbeat keeps the session alive
        // The 30-min server timeout will handle the final save
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [sessionId, analysisResult, stateFingerprint]);

  // Heartbeat every 5 minutes to keep session alive
  useEffect(() => {
    if (!sessionId) return;
    const interval = setInterval(() => {
      fetch('/api/session/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {});
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [sessionId]);

  async function uploadAdaptedPdf() {
    const state = useAnalyzerStore.getState();
    if (!state.analysisResult || !state.sessionId) return;

    // Generate teacher PDF via the export endpoint
    const exportData = buildExportData(state);

    const res = await fetch('/api/analyzer/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exportData),
    });

    if (!res.ok) {
      console.warn('Auto-save export failed:', res.status);
      return;
    }

    const buf = await res.arrayBuffer();
    // Safe base64 encoding (chunked to avoid call stack overflow for large PDFs)
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.slice(i, i + 8192));
    }
    const base64 = btoa(binary);

    await fetch('/api/session/upload-adapted', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.sessionId,
        pdfBase64: base64,
        filename: `adapted_${state.sessionId}.pdf`,
      }),
    });
  }
}

/**
 * Build export data for teacher version (mirrors Legend's buildExportData).
 */
function buildExportData(state) {
  const { analysisResult, wordModifications, sentenceRewrites, selectedUnits } = state;

  const glossedWords = [];
  const unknownWords = [];
  const vocabChanges = [];
  const grammarChanges = [];
  const originalWordColors = {};

  for (const [key, mod] of Object.entries(wordModifications)) {
    if (mod.type === 'glossed') {
      glossedWords.push({ word: mod.originalWord, translation: mod.translation || '' });
      vocabChanges.push({ original: mod.originalWord, replacement: mod.originalWord, explanation: 'glossed in text', isGloss: true });
    } else if (mod.type === 'replaced') {
      vocabChanges.push({ original: mod.originalWord, replacement: mod.replacement });
    }
  }

  for (const sentence of analysisResult.sentences) {
    for (let wi = 0; wi < sentence.words.length; wi++) {
      const word = sentence.words[wi];
      if (word.type !== 'word') continue;
      const si = analysisResult.sentences.indexOf(sentence);
      const modKey = `${si}_${wi}`;
      const mod = wordModifications[modKey];
      const wLower = word.text.toLowerCase();

      if (mod?.type === 'glossed') originalWordColors[wLower] = 'glossed';
      else if (mod?.type === 'replaced' || mod?.type === 'marked_known') originalWordColors[wLower] = 'known';
      else if (word.status === 'unknown') { originalWordColors[wLower] = 'unknown'; unknownWords.push(word.text); }
      else originalWordColors[wLower] = 'known';
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

  let originalText = '', finalText = '';
  for (let si = 0; si < analysisResult.sentences.length; si++) {
    const sentence = analysisResult.sentences[si];
    for (const word of sentence.words) originalText += word.text;
    originalText += ' ';

    const rewrite = sentenceRewrites[si];
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
    .map(s => ({ sentence: s.text, issue: s.grammar.issues?.[0]?.description || '', suggestion: s.grammar.issues?.[0]?.suggestion || '' }));

  const totalWords = analysisResult.sentences.flatMap(s => s.words).filter(w => w.type === 'word').length;
  const knownWords = analysisResult.sentences.flatMap(s => s.words).filter(w => w.type === 'word' && w.status === 'known').length;
  const unknownSet = new Set(unknownWords.map(w => w.toLowerCase()));
  const finalWords = finalText.trim().replace(/[.,!?;:]/g, '').split(/\s+/).filter(Boolean);
  let newKnown = 0;
  for (const fw of finalWords) { if (!unknownSet.has(fw.toLowerCase())) newKnown++; }

  const id1Units = [], id2bUnits = [], id2oUnits = [];
  for (const uid of selectedUnits) {
    if (uid.startsWith('B')) id2bUnits.push(parseInt(uid.slice(1)));
    else if (uid.startsWith('O')) id2oUnits.push(parseInt(uid.slice(1)));
    else id1Units.push(parseInt(uid));
  }
  const lines = [];
  if (id1Units.length) lines.push(`Impuls Deutsch 1: ${id1Units.sort((a,b)=>a-b).join(', ')}`);
  if (id2bUnits.length) lines.push(`Impuls Deutsch 2 BLAU: ${id2bUnits.sort((a,b)=>a-b).join(', ')}`);
  if (id2oUnits.length) lines.push(`Impuls Deutsch 2 ORANGE: ${id2oUnits.sort((a,b)=>a-b).join(', ')}`);

  return {
    text: finalText.trim(),
    originalText: originalText.trim(),
    glossedWords,
    title: 'Text Analysis',
    mode: 'teacher',
    annotations: {
      unknownWords, grammarNotes, grammarChanges, vocabChanges, originalWordColors,
      readability: {
        percent: totalWords > 0 ? Math.round((knownWords / totalWords) * 100) : 100,
        knownWords, totalWords, grammarIssues: grammarNotes.length,
      },
      newReadability: {
        percent: finalWords.length > 0 ? Math.round((newKnown / finalWords.length) * 100) : 100,
        knownWords: newKnown, totalWords: finalWords.length,
      },
      selectedUnits: lines.join('\n'),
    },
  };
}
