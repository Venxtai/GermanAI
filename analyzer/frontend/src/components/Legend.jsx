import { useState, useMemo } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';

export default function Legend() {
  const { analysisResult, wordModifications, sentenceRewrites, selectedUnits, sessionId } = useAnalyzerStore();
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exporting, setExporting] = useState(null); // 'student' | 'teacher' | null

  // ALL hooks before any returns
  const glossedCount = useMemo(() => {
    if (!analysisResult) return 0;
    let count = 0;
    for (const [key, mod] of Object.entries(wordModifications)) {
      if (mod.type !== 'glossed') continue;
      const si = parseInt(key.split('_')[0]);
      if (sentenceRewrites[si]) {
        const rewritten = sentenceRewrites[si].rewritten?.toLowerCase() || '';
        if (rewritten.includes(mod.originalWord.toLowerCase())) count++;
      } else {
        count++;
      }
    }
    return count;
  }, [analysisResult, wordModifications, sentenceRewrites]);

  if (!analysisResult) return null;

  // Build export data from current analysis state
  const buildExportData = (mode) => {
    const glossedWords = [];
    const unknownWords = [];
    const replacedWords = [];
    const wordNotes = [];

    for (const [key, mod] of Object.entries(wordModifications)) {
      if (mod.type === 'glossed') {
        glossedWords.push({ word: mod.originalWord, translation: mod.translation || '' });
        wordNotes.push({ word: mod.originalWord, status: 'glossed', detail: mod.translation || '' });
      } else if (mod.type === 'replaced') {
        replacedWords.push(mod.replacement);
        wordNotes.push({ word: mod.originalWord, status: 'replaced', detail: `→ ${mod.replacement}` });
      }
    }

    // Build per-word color map from analysis status + modifications
    // This is the source of truth for coloring in the PDF
    const originalWordColors = {}; // word (lowercase) -> 'known' | 'unknown' | 'glossed'
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
          originalWordColors[wLower] = 'known'; // replaced/marked = dealt with
        } else if (word.status === 'unknown') {
          originalWordColors[wLower] = 'unknown';
          unknownWords.push(word.text);
        } else {
          originalWordColors[wLower] = 'known';
        }
      }
    }

    // Build final text with replacements and rewrites applied
    let finalText = '';
    for (let si = 0; si < analysisResult.sentences.length; si++) {
      const sentence = analysisResult.sentences[si];
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

    // Grammar notes
    const grammarNotes = analysisResult.sentences
      .filter(s => s.grammar.status === 'issue')
      .map(s => ({
        sentence: s.text,
        issue: s.grammar.issues?.[0]?.description || 'Grammar issue detected',
        suggestion: s.grammar.issues?.[0]?.suggestion || '',
      }));

    // Build original text (before any changes)
    let originalText = '';
    for (const sentence of analysisResult.sentences) {
      for (const word of sentence.words) {
        originalText += word.text;
      }
      originalText += ' ';
    }

    // Original readability (from analysis)
    const totalWords = analysisResult.sentences.flatMap(s => s.words).filter(w => w.type === 'word').length;
    const knownWords = analysisResult.sentences.flatMap(s => s.words).filter(w => w.type === 'word' && w.status === 'known').length;

    // New readability (after all changes — replacements count as known)
    const unknownSet = new Set(unknownWords.map(w => w.toLowerCase()));
    const finalWords = finalText.trim().replace(/[.,!?;:"""„''()\[\]{}–—…]/g, '').split(/\s+/).filter(Boolean);
    const newTotal = finalWords.length;
    let newKnown = 0;
    for (const fw of finalWords) {
      if (!unknownSet.has(fw.toLowerCase())) newKnown++;
    }

    // Separate vocab changes from grammar changes
    const vocabChanges = [];
    const grammarChanges = [];

    // Word-level replacements and glosses are vocab changes
    for (const [key, mod] of Object.entries(wordModifications)) {
      if (mod.type === 'replaced') {
        vocabChanges.push({ original: mod.originalWord, replacement: mod.replacement });
      } else if (mod.type === 'glossed') {
        vocabChanges.push({ original: mod.originalWord, replacement: mod.originalWord, explanation: 'glossed in text', isGloss: true });
      }
    }

    // Sentence-level rewrites: separate by type
    for (const [si, rewrite] of Object.entries(sentenceRewrites)) {
      if (!rewrite?.changes) continue;
      const isWordReplacement = rewrite.targetStructure === 'word-replacement';
      for (const c of rewrite.changes) {
        if (isWordReplacement) {
          vocabChanges.push({ original: c.original, replacement: c.replacement });
        } else {
          grammarChanges.push({ original: c.original, replacement: c.replacement, explanation: c.explanation });
        }
      }
    }

    // Selected units grouped by book
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

    return {
      text: finalText.trim(),
      originalText: originalText.trim(),
      glossedWords,
      title: 'Text Analysis',
      mode,
      annotations: mode === 'teacher' ? {
        unknownWords,
        replacedWords,
        grammarNotes,
        grammarChanges,
        vocabChanges,
        originalWordColors,
        readability: {
          percent: totalWords > 0 ? Math.round((knownWords / totalWords) * 100) : 100,
          knownWords,
          totalWords,
          grammarIssues: grammarNotes.length,
        },
        newReadability: {
          percent: newTotal > 0 ? Math.round((newKnown / newTotal) * 100) : 100,
          knownWords: newKnown,
          totalWords: newTotal,
        },
        selectedUnits: unitsList,
      } : undefined,
    };
  };

  const handleExport = async (mode) => {
    setExporting(mode);
    setShowExportMenu(false);

    try {
      const data = buildExportData(mode);
      const res = await fetch('/api/analyzer/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!res.ok) throw new Error('Export failed');

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = mode === 'teacher' ? 'text-analysis-teacher-key.pdf' : 'text-analysis-student.pdf';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
      alert('Export failed: ' + err.message);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="bg-white border-t border-slate-200 px-6 py-2 flex items-center justify-between flex-shrink-0">
      <div className="flex items-center gap-4 text-xs">
        <LegendItem color="bg-[var(--brand)]" label="Known" />
        <LegendItem color="bg-[var(--color-unknown)]" label="Unknown" />
        <LegendItem color="bg-[var(--color-replaced)]" label="Replaced" />
        <LegendItem color="bg-[var(--color-glossed)]" label="Translated" />
      </div>

      {sessionId && (
        <span className="text-xs text-slate-300 font-mono">{sessionId}</span>
      )}

      <div className="relative">
        <button
          onClick={() => setShowExportMenu(!showExportMenu)}
          disabled={!!exporting}
          className="px-4 py-1.5 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-1.5"
          style={{ backgroundColor: 'var(--brand)' }}
          onMouseEnter={e => { if (!e.target.disabled) e.target.style.backgroundColor = 'var(--brand-dark)'; }}
          onMouseLeave={e => e.target.style.backgroundColor = 'var(--brand)'}
        >
          {exporting ? `Exporting ${exporting}...` : (
            <>
              Export PDF {glossedCount > 0 && `(${glossedCount} glossed)`}
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </>
          )}
        </button>

        {showExportMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowExportMenu(false)} />
            <div className="absolute right-0 bottom-full mb-1 z-50 bg-white rounded-lg shadow-xl border border-slate-200 py-1 w-56">
              <button
                onClick={() => handleExport('student')}
                className="w-full text-left px-4 py-2.5 hover:bg-slate-50 transition-colors"
              >
                <span className="text-sm font-medium text-slate-700 block">Student Version</span>
                <span className="text-xs text-slate-400">Clean text with glossary only</span>
              </button>
              <div className="border-t border-slate-100" />
              <button
                onClick={() => handleExport('teacher')}
                className="w-full text-left px-4 py-2.5 hover:bg-slate-50 transition-colors"
              >
                <span className="text-sm font-medium text-slate-700 block">Teacher Version</span>
                <span className="text-xs text-slate-400">Color-coded with annotations & grammar notes</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function LegendItem({ color, label }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-full ${color}`} />
      <span className="text-slate-500">{label}</span>
    </div>
  );
}
