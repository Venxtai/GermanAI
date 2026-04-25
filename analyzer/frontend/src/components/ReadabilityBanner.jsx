import { useMemo, useState } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';
import { calculateReadability } from '../utils/readabilityCalc';
import UniqueWordsPopup from './UniqueWordsPopup';

export default function ReadabilityBanner() {
  const {
    analysisResult, whatIfMode, whatIfResults, whatIfLoading,
    sentenceRewrites, wordModifications, compareMode,
  } = useAnalyzerStore();

  const [uniquePopup, setUniquePopup] = useState(null); // 'cognate' | 'unknown' | null

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

  const { percent, knownWords, totalWords, translatedWords, cognateWords, uniqueCognates, uniqueUnknown } = readability;
  const grammarIssues = (whatIfMode && whatIfResults)
    ? analysisResult.readability.grammarIssues
    : liveReadability.grammarIssues;

  const originalPercent = analysisResult.readability.percent;
  const diff = whatIfMode && whatIfResults ? percent - originalPercent : 0;

  // Brand-aligned: teal for good, amber for medium, orange for poor
  const barColor = percent >= 90 ? 'bg-[var(--brand)]' : percent >= 70 ? 'bg-[var(--brand-orange)]' : 'bg-[var(--color-unknown)]';
  const textColor = percent >= 90 ? 'text-[var(--brand)]' : percent >= 70 ? 'text-[var(--brand-orange)]' : 'text-[var(--color-unknown)]';
  const bgColor = percent >= 90 ? 'bg-[var(--brand-light)]' : percent >= 70 ? 'bg-[#fef3ee]' : 'bg-[var(--color-unknown-bg)]';

  const cog = cognateWords || 0;
  const unknown = totalWords - knownWords - translatedWords - cog;

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
            const parts = [];
            if (knownWords > 0) parts.push(<span key="known">{knownWords} known</span>);
            if (cog > 0) parts.push(
              <span key="cog">
                {cog} cognate{cog !== 1 ? 's' : ''}{' '}
                (<button className="underline hover:text-[var(--brand)]" onClick={() => setUniquePopup('cognate')}>{uniqueCognates} unique</button>)
              </span>
            );
            if (translatedWords > 0) parts.push(<span key="trans">{translatedWords} translated</span>);
            if (unknown > 0) parts.push(
              <span key="unk">
                {unknown} unknown{' '}
                (<button className="underline hover:text-[var(--color-unknown)]" onClick={() => setUniquePopup('unknown')}>{uniqueUnknown} unique</button>)
              </span>
            );
            return parts.reduce((acc, part, i) => {
              if (i === 0) return [part];
              if (i === parts.length - 1) return [...acc, <span key={`and${i}`}> and </span>, part];
              return [...acc, <span key={`sep${i}`}>, </span>, part];
            }, []);
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

      {uniquePopup && (
        <UniqueWordsPopup
          type={uniquePopup}
          onClose={() => setUniquePopup(null)}
        />
      )}
    </div>
  );
}
