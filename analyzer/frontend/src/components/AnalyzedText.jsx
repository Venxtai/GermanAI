import { useMemo, useEffect, useRef } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';

export default function AnalyzedText() {
  const {
    analysisResult, selectWord, selectCircle, selectedWord, selectedCircle,
    wordModifications, sentenceRewrites, wordFormatting,
    whatIfMode, whatIfUnits, whatIfResults, whatIfLoading,
    setWhatIfResults, setWhatIfLoading,
  } = useAnalyzerStore();

  const timerRef = useRef(null);

  // Serialize whatIfUnits to a string so useEffect can detect changes
  const whatIfUnitsKey = whatIfMode && whatIfUnits ? [...whatIfUnits].sort().join(',') : '';

  // Auto-recheck when whatIfUnits change
  useEffect(() => {
    if (!whatIfMode || !analysisResult || !whatIfUnitsKey) return;

    // Debounce: wait 250ms after last change
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      setWhatIfLoading(true);

      // Extract words + lemmas from the original analysis
      const words = analysisResult.sentences.flatMap(s =>
        s.words.filter(w => w.type === 'word').map(w => ({
          text: w.text,
          lemma: w.lemma || w.text,
        }))
      );

      try {
        const res = await fetch('/api/analyzer/recheck', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            words,
            selectedUnits: whatIfUnitsKey.split(','),
          }),
        });
        const data = await res.json();
        setWhatIfResults(data);
      } catch (err) {
        console.error('What If recheck failed:', err);
      } finally {
        setWhatIfLoading(false);
      }
    }, 250);

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [whatIfUnitsKey, whatIfMode, analysisResult]);

  if (!analysisResult) return null;

  // In What If mode, build a flat index mapping content-word position to whatIfResults status
  const whatIfStatusMap = useMemo(() => {
    if (!whatIfMode || !whatIfResults?.wordStatuses) return null;
    // whatIfResults.wordStatuses is a flat array of all content words across all sentences
    // We need to map: (sentenceIndex, wordIndex) -> whatIf status
    const map = {};
    let flatIdx = 0;
    for (let si = 0; si < analysisResult.sentences.length; si++) {
      for (let wi = 0; wi < analysisResult.sentences[si].words.length; wi++) {
        const w = analysisResult.sentences[si].words[wi];
        if (w.type === 'word') {
          map[`${si}_${wi}`] = whatIfResults.wordStatuses[flatIdx] || null;
          flatIdx++;
        }
      }
    }
    return map;
  }, [whatIfMode, whatIfResults, analysisResult]);

  return (
    <div className="max-w-3xl mx-auto">
      {whatIfMode && whatIfLoading && (
        <div className="text-center text-sm text-amber-600 mb-2 animate-pulse">
          Rechecking with new units...
        </div>
      )}
      <div className="bg-white rounded-xl border border-slate-200 p-6 leading-relaxed text-base">
        {analysisResult.sentences.map((sentence, si) => (
          <span key={si}>
            {sentence.paragraphBreak && <><br /><br /></>}
            <SentenceDisplay
              sentence={sentence}
              sentenceIndex={si}
              selectWord={selectWord}
              selectCircle={selectCircle}
              selectedWord={selectedWord}
              selectedCircle={selectedCircle}
              wordModifications={wordModifications}
              wordFormatting={wordFormatting}
              sentenceRewrite={sentenceRewrites[si]}
              whatIfStatusMap={whatIfStatusMap}
            />
          </span>
        ))}
      </div>
    </div>
  );
}

function SentenceDisplay({
  sentence, sentenceIndex, selectWord, selectCircle,
  selectedWord, selectedCircle, wordModifications, wordFormatting,
  sentenceRewrite, whatIfStatusMap,
}) {
  const { selectRewriteWord, selectedRewriteWord } = useAnalyzerStore();

  // Determine grammar circle color
  // Word replacements keep original grammar status; only grammar rewrites turn blue
  // Circle color: blue if grammar was rewritten (directly or as part of a chain), else original status
  const isGrammarRewrite = sentenceRewrite && sentenceRewrite.targetStructure !== 'word-replacement';
  const grammarWasFixed = sentenceRewrite?.grammarFixed || isGrammarRewrite;
  const grammarStatus = grammarWasFixed ? 'rewritten' : sentence.grammar.status;
  const circleColor = grammarStatus === 'issue' ? 'bg-[var(--color-unknown)]' :
                      grammarStatus === 'rewritten' ? 'bg-[var(--color-replaced)]' : 'bg-[var(--brand)]';
  const isCircleSelected = selectedCircle?.sentenceIndex === sentenceIndex;

  // If sentence was rewritten, show the rewritten version
  const displayText = sentenceRewrite?.rewritten || null;

  return (
    <span className="inline">
      {displayText ? (
        // Show rewritten sentence with proper per-word coloring and click handlers
        <RewrittenSentence
          displayText={displayText}
          sentenceRewrite={sentenceRewrite}
          originalWords={sentence.words}
          wordModifications={wordModifications}
          sentenceIndex={sentenceIndex}
          selectRewriteWord={selectRewriteWord}
          selectedRewriteWord={selectedRewriteWord}
        />
      ) : (
        // Show original words with colors
        sentence.words.map((word, wi) => {
          const fmtKey = `${sentenceIndex}_${wi}`;
          const fmt = wordFormatting?.[fmtKey];
          const fmtStyle = (fmt?.bold || fmt?.italic) ? {
            fontWeight: fmt?.bold ? 700 : undefined,
            fontStyle: fmt?.italic ? 'italic' : undefined,
          } : undefined;

          if (word.type === 'whitespace') return <span key={wi}>{word.text}</span>;
          if (word.type === 'punctuation') {
            // Apply formatting to punctuation adjacent to formatted words
            return <span key={wi} style={fmtStyle}>{word.text}</span>;
          }

          const modKey = fmtKey;
          const mod = wordModifications[modKey];
          const displayWord = mod?.type === 'replaced' ? mod.replacement : word.text;

          // In What If mode, use whatIfStatusMap for the word status
          let status;
          if (mod?.type === 'replaced') {
            status = 'replaced';
          } else if (mod?.type === 'glossed') {
            status = 'glossed';
          } else if (mod?.type === 'marked_known') {
            status = 'known';
          } else if (mod?.type === 'marked_cognate') {
            status = 'cognate';
          } else if (whatIfStatusMap) {
            // What If mode: use rechecked status
            const wiStatus = whatIfStatusMap[modKey];
            status = wiStatus ? wiStatus.status : word.status;
          } else {
            status = word.status;
          }

          const colorClass = getWordColorClass(status);
          const isSelected = selectedWord?.sentenceIndex === sentenceIndex && selectedWord?.wordIndex === wi;

          return (
            <span
              key={wi}
              onClick={() => selectWord(sentenceIndex, wi)}
              className={`cursor-pointer rounded px-0.5 transition-all duration-300 ${colorClass} ${
                isSelected ? 'ring-2 ring-[var(--brand)] ring-offset-1' : ''
              } ${word.linkedGroup ? 'underline decoration-dotted decoration-slate-400 underline-offset-4' : ''}`}
              style={fmtStyle}
            >
              {displayWord}
            </span>
          );
        })
      )}

      {/* Grammar circle */}
      <span
        onClick={() => selectCircle(sentenceIndex)}
        className={`inline-block w-3 h-3 rounded-full ml-1 cursor-pointer align-middle transition-all ${circleColor} ${
          isCircleSelected ? 'ring-2 ring-[var(--brand)] ring-offset-1 scale-125' : 'hover:scale-110'
        }`}
        title={grammarStatus === 'issue' ? 'Grammar issue' : grammarStatus === 'rewritten' ? 'Rewritten' : 'Grammar OK'}
      />
      {' '}
    </span>
  );
}

/**
 * Renders a rewritten sentence with proper color logic and click handlers.
 * - Words that were glossed in the original → stay grey
 * - Words introduced by the rewrite → blue (clickable, shows replacement + vocab info)
 * - Unchanged words keep their original status (green/red)
 */
function RewrittenSentence({
  displayText, sentenceRewrite, originalWords, wordModifications,
  sentenceIndex, selectRewriteWord, selectedRewriteWord,
}) {
  // Build a set of glossed words from the original sentence (lowercased)
  const glossedWords = new Set();
  const originalStatuses = {};
  for (let wi = 0; wi < originalWords.length; wi++) {
    const w = originalWords[wi];
    if (w.type !== 'word') continue;
    const modKey = `${sentenceIndex}_${wi}`;
    const mod = wordModifications[modKey];
    if (mod?.type === 'glossed') {
      glossedWords.add(w.text.toLowerCase());
    }
    originalStatuses[w.text.toLowerCase()] = w.status;
  }

  // Build set of words that are NEW in the rewrite (not in original sentence)
  const originalWordSet = new Set(
    originalWords.filter(w => w.type === 'word').map(w => w.text.toLowerCase())
  );

  // Words from the replacement that aren't in the original → these are "changed"
  const changedWords = new Set();
  for (const c of (sentenceRewrite?.changes || [])) {
    // Add all words from the rewritten sentence that weren't in the original
    if (c.replacement) {
      // The replacement field might be the alternative phrase (e.g., "gern fahren")
      // But the actual rewritten sentence has conjugated forms (e.g., "fahre gern")
      // So we compare: words in rewritten NOT in original = changed
    }
    // Also track the original word that was replaced
    if (c.original) {
      changedWords.add(c.original.toLowerCase());
    }
  }

  // Compare rewritten words vs original words to find what's new
  const rewrittenWordList = displayText.replace(/[.,!?;:]/g, '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const rw of rewrittenWordList) {
    if (!originalWordSet.has(rw)) {
      changedWords.add(rw);
    }
  }

  return (
    <span className="inline">
      {displayText.split(/(\s+)/).map((part, i) => {
        // Split punctuation from words
        const match = part.match(/^([.,!?;:]*)([a-zA-ZäöüÄÖÜßéèêàâ]*)([.,!?;:]*)$/);
        if (!match || !part.trim()) return <span key={i}>{part}</span>;

        const leadPunct = match[1];
        const word = match[2];
        const trailPunct = match[3];

        if (!word) return <span key={i}>{part}</span>;

        const wordLower = word.toLowerCase();
        const isSelected = selectedRewriteWord?.sentenceIndex === sentenceIndex &&
          selectedRewriteWord?.wordText?.toLowerCase() === wordLower;

        // Determine color
        let colorClass;
        let isChanged = false;

        if (glossedWords.has(wordLower)) {
          colorClass = 'bg-gray-200 text-gray-600 hover:bg-gray-300';
        } else if (changedWords.has(wordLower)) {
          colorClass = 'bg-blue-100 text-blue-800 hover:bg-blue-200';
          isChanged = true;
        } else {
          const origStatus = originalStatuses[wordLower];
          colorClass = origStatus ? getWordColorClass(origStatus) : 'bg-green-100 text-green-800 hover:bg-green-200';
        }

        return (
          <span key={i}>
            {leadPunct}
            <span
              onClick={() => selectRewriteWord(sentenceIndex, word, isChanged)}
              className={`cursor-pointer rounded px-0.5 transition-all ${colorClass} ${
                isSelected ? 'ring-2 ring-[var(--brand)] ring-offset-1' : ''
              }`}
            >
              {word}
            </span>
            {trailPunct}
          </span>
        );
      })}
    </span>
  );
}

export function getWordColorClass(status) {
  switch (status) {
    case 'known': return 'bg-[var(--color-known-bg)] text-[var(--color-known)] hover:brightness-95';
    case 'unknown': return 'bg-[var(--color-unknown-bg)] text-[var(--color-unknown)] hover:brightness-95';
    case 'replaced': return 'bg-[var(--color-replaced-bg)] text-[var(--color-replaced)] hover:brightness-95';
    case 'glossed': return 'bg-[var(--color-glossed-bg)] text-[var(--color-glossed)] hover:brightness-95';
    case 'cognate': return 'bg-[var(--color-cognate-bg)] text-[var(--color-cognate)] hover:brightness-95';
    default: return '';
  }
}
