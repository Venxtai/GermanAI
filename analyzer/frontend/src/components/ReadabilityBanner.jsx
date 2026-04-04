import { useMemo } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';
import { calculateReadability } from '../utils/readabilityCalc';

export default function ReadabilityBanner() {
  const {
    analysisResult, whatIfMode, whatIfResults, whatIfLoading,
    sentenceRewrites, wordModifications, compareMode,
  } = useAnalyzerStore();

  // ALL hooks must be before any returns
  const liveReadability = useMemo(() => {
    return calculateReadability(analysisResult, sentenceRewrites, wordModifications);
  }, [analysisResult, sentenceRewrites, wordModifications]);

  if (!analysisResult) return null;
  if (compareMode) return null;

  // In What If mode, use the What If readability instead
  const readability = (whatIfMode && whatIfResults?.readability)
    ? whatIfResults.readability
    : liveReadability;

  const { percent, knownWords, totalWords, translatedWords, cognateWords } = readability;
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
          {totalWords} {totalWords === 1 ? 'word' : 'words'}:{' '}
          {(() => {
            const cog = cognateWords || 0;
            const unknown = totalWords - knownWords - translatedWords - cog;
            const parts = [];
            if (knownWords > 0) parts.push(`${knownWords} known`);
            if (cog > 0) parts.push(`${cog} cognate${cog !== 1 ? 's' : ''}`);
            if (translatedWords > 0) parts.push(`${translatedWords} translated`);
            if (unknown > 0) parts.push(`${unknown} unknown`);
            return parts.length > 2
              ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]
              : parts.join(' and ');
          })()}
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
