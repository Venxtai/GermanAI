import { useMemo, useState } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';

/**
 * Popup showing unique cognate or unknown words with options to reclassify them.
 * For unknown words: can mark as Known or Cognate
 * For cognates: can mark as Known
 */
export default function UniqueWordsPopup({ type, onClose }) {
  const { analysisResult, wordModifications, setWordModification, sentenceRewrites } = useAnalyzerStore();
  const [selected, setSelected] = useState(new Set());

  // Collect unique words with all their occurrences
  const uniqueWords = useMemo(() => {
    if (!analysisResult?.sentences) return [];
    const map = new Map(); // lemma → { lemma, text, occurrences: [{si, wi}] }

    for (let si = 0; si < analysisResult.sentences.length; si++) {
      const sentence = analysisResult.sentences[si];
      // Skip rewritten sentences
      if (sentenceRewrites[si]?.rewritten) continue;

      for (let wi = 0; wi < sentence.words.length; wi++) {
        const w = sentence.words[wi];
        if (w.type !== 'word') continue;

        const modKey = `${si}_${wi}`;
        const mod = wordModifications[modKey];

        let isTarget = false;
        if (type === 'unknown') {
          // Unknown: no modification and status is unknown
          isTarget = !mod && w.status === 'unknown';
        } else if (type === 'cognate') {
          // Cognate: either original cognate or marked_cognate
          isTarget = (mod?.type === 'marked_cognate') || (!mod && w.status === 'cognate');
        }

        if (!isTarget) continue;

        const lemma = (w.lemma || w.text).toLowerCase();
        if (!map.has(lemma)) {
          map.set(lemma, {
            lemma: w.lemma || w.text,
            text: w.text,
            count: 0,
            occurrences: [],
          });
        }
        const entry = map.get(lemma);
        entry.count++;
        entry.occurrences.push({ si, wi });
      }
    }

    return Array.from(map.values()).sort((a, b) => a.lemma.localeCompare(b.lemma));
  }, [analysisResult, wordModifications, sentenceRewrites, type]);

  const toggleSelect = (lemma) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(lemma)) next.delete(lemma);
      else next.add(lemma);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === uniqueWords.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(uniqueWords.map(w => w.lemma.toLowerCase())));
    }
  };

  const applyAction = (action) => {
    for (const word of uniqueWords) {
      if (!selected.has(word.lemma.toLowerCase())) continue;
      for (const { si, wi } of word.occurrences) {
        if (action === 'known') {
          setWordModification(si, wi, { type: 'marked_known', originalWord: word.text });
        } else if (action === 'cognate') {
          setWordModification(si, wi, { type: 'marked_cognate', originalWord: word.text });
        }
      }
    }
    setSelected(new Set());
  };

  const title = type === 'unknown' ? 'Unique Unknown Words' : 'Unique Cognates';
  const color = type === 'unknown' ? 'var(--color-unknown)' : 'var(--color-cognate)';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-[480px] max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-3 border-b border-slate-200">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold" style={{ color }}>{title}</h3>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg">&times;</button>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {uniqueWords.length} unique word{uniqueWords.length !== 1 ? 's' : ''}.
            Select words to reclassify them.
          </p>
        </div>

        {/* Word list */}
        <div className="flex-1 overflow-y-auto px-6 py-3">
          {uniqueWords.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-4">No words found.</p>
          ) : (
            <>
              <label className="flex items-center gap-2 pb-2 mb-2 border-b border-slate-100 cursor-pointer text-xs text-slate-500 hover:text-slate-700">
                <input
                  type="checkbox"
                  checked={selected.size === uniqueWords.length && uniqueWords.length > 0}
                  onChange={selectAll}
                  className="accent-[var(--brand)] w-3.5 h-3.5"
                />
                Select all
              </label>
              {uniqueWords.map(w => (
                <label
                  key={w.lemma}
                  className="flex items-center gap-2 py-1.5 cursor-pointer hover:bg-slate-50 rounded px-1 -mx-1"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(w.lemma.toLowerCase())}
                    onChange={() => toggleSelect(w.lemma.toLowerCase())}
                    className="accent-[var(--brand)] w-3.5 h-3.5 flex-shrink-0"
                  />
                  <span className="text-sm font-medium text-slate-800">{w.lemma}</span>
                  {w.count > 1 && (
                    <span className="text-xs text-slate-400">({w.count}x)</span>
                  )}
                </label>
              ))}
            </>
          )}
        </div>

        {/* Actions */}
        {selected.size > 0 && (
          <div className="px-6 py-3 border-t border-slate-200 flex gap-2">
            <span className="text-xs text-slate-500 self-center mr-auto">{selected.size} selected</span>
            <button
              onClick={() => applyAction('known')}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors"
              style={{ backgroundColor: 'var(--brand-light)', color: 'var(--brand)', borderColor: 'var(--brand)' }}
            >
              Mark as Known
            </button>
            {type === 'unknown' && (
              <button
                onClick={() => applyAction('cognate')}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors"
                style={{ backgroundColor: 'var(--color-cognate-bg)', color: 'var(--color-cognate)', borderColor: 'var(--color-cognate)' }}
              >
                Mark as Cognate
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
