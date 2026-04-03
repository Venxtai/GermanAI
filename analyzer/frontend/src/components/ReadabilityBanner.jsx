import { useMemo } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';

export default function ReadabilityBanner() {
  const {
    analysisResult, whatIfMode, whatIfResults, whatIfLoading,
    sentenceRewrites, wordModifications,
  } = useAnalyzerStore();

  // ALL hooks must be before any returns
  const liveReadability = useMemo(() => {
    if (!analysisResult) return { percent: 100, knownWords: 0, totalWords: 0, grammarIssues: 0, translatedWords: 0 };
    let total = 0;
    let known = 0;
    let translated = 0;
    let grammarIssues = 0;

    for (let si = 0; si < analysisResult.sentences.length; si++) {
      const sentence = analysisResult.sentences[si];
      const rewrite = sentenceRewrites[si];

      // Grammar: fixed if rewrite exists with grammarFixed or is a grammar rewrite
      const grammarFixed = rewrite?.grammarFixed ||
        (rewrite && rewrite.targetStructure !== 'word-replacement');
      if (sentence.grammar.status === 'issue' && !grammarFixed) {
        grammarIssues++;
      }

      if (rewrite?.rewritten) {
        // Count words in rewritten sentence — all replacement words are "known" by design
        // (teacher chose them from known vocabulary)
        const origWordSet = new Set(
          sentence.words.filter(w => w.type === 'word').map(w => w.text.toLowerCase())
        );
        const rewrittenWords = rewrite.rewritten
          .replace(/[.,!?;:"""„''()\[\]{}–—…]/g, '')
          .split(/\s+/)
          .filter(Boolean);

        for (const rw of rewrittenWords) {
          total++;
          const rwLower = rw.toLowerCase();
          // New words from rewrite are considered known (teacher chose them)
          if (!origWordSet.has(rwLower)) {
            known++;
          } else {
            // Original word — check its status
            const origWord = sentence.words.find(w =>
              w.type === 'word' && w.text.toLowerCase() === rwLower
            );
            if (origWord?.status === 'known') known++;
            // Check if it was modified (glossed words are still unknown)
          }
        }
      } else {
        // No rewrite — use original word statuses
        for (let wi = 0; wi < sentence.words.length; wi++) {
          const w = sentence.words[wi];
          if (w.type !== 'word') continue;
          total++;

          const modKey = `${si}_${wi}`;
          const mod = wordModifications[modKey];
          if (mod?.type === 'replaced') {
            known++; // Replaced with known word
          } else if (mod?.type === 'glossed') {
            known++; // Translated word counts as accessible
            translated++;
          } else if (w.status === 'known') {
            known++;
          }
        }
      }
    }

    const percent = total > 0 ? Math.round((known / total) * 100) : 100;
    return { percent, knownWords: known - translated, totalWords: total, grammarIssues, translatedWords: translated };
  }, [analysisResult, sentenceRewrites, wordModifications]);

  if (!analysisResult) return null;

  // In What If mode, use the What If readability instead
  const readability = (whatIfMode && whatIfResults?.readability)
    ? whatIfResults.readability
    : liveReadability;

  const { percent, knownWords, totalWords, translatedWords } = readability;
  const grammarIssues = (whatIfMode && whatIfResults)
    ? analysisResult.readability.grammarIssues
    : liveReadability.grammarIssues;

  const originalPercent = analysisResult.readability.percent;
  const diff = whatIfMode && whatIfResults ? percent - originalPercent : 0;

  // Brand-aligned: teal for good, amber for medium, orange for poor
  const barColor = percent >= 90 ? 'bg-[var(--brand)]' : percent >= 70 ? 'bg-[var(--brand-orange)]' : 'bg-[var(--color-unknown)]';
  const textColor = percent >= 90 ? 'text-[var(--brand)]' : percent >= 70 ? 'text-[var(--brand-orange)]' : 'text-[var(--color-unknown)]';
  const bgColor = percent >= 90 ? 'bg-[var(--brand-light)]' : percent >= 70 ? 'bg-[#fef3ee]' : 'bg-[var(--color-unknown-bg)]';

  return (
    <div className={`px-6 py-2 flex items-center gap-4 border-b border-slate-200 ${bgColor} flex-shrink-0 transition-colors duration-300`}>
      {whatIfMode && (
        <span className="text-xs font-medium text-amber-600 bg-amber-100 px-2 py-0.5 rounded">
          {whatIfLoading ? 'Checking...' : 'What If'}
        </span>
      )}

      <div className="flex items-center gap-2 flex-1">
        <span className={`text-sm font-semibold ${textColor} transition-colors duration-300`}>{percent}%</span>
        <div className="flex-1 max-w-xs h-2 bg-slate-200 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${percent}%` }} />
        </div>
        <span className="text-xs text-slate-500">
          {knownWords}/{totalWords} words known{translatedWords > 0 ? `, ${translatedWords}/${totalWords} translated` : ''}
        </span>
        {diff !== 0 && (
          <span className={`text-xs font-semibold ${diff > 0 ? 'text-green-600' : 'text-red-600'}`}>
            ({diff > 0 ? '+' : ''}{diff}% vs original)
          </span>
        )}
      </div>

      {grammarIssues > 0 && (
        <span className="text-xs text-[var(--color-unknown)] font-medium">
          {grammarIssues} grammar {grammarIssues === 1 ? 'issue' : 'issues'}
        </span>
      )}

      {grammarIssues === 0 && (
        <span className="text-xs text-[var(--brand)] font-medium">
          No grammar issues
        </span>
      )}

    </div>
  );
}
