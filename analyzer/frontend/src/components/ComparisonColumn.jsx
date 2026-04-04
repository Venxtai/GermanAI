import { useMemo } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';
import { getWordColorClass } from './AnalyzedText';
import { calculateReadability } from '../utils/readabilityCalc';

export default function ComparisonColumn({ compareText }) {
  const {
    activeCompareId, setActiveCompareId,
    promoteCompareText, editCompareText,
    isReadOnly,
  } = useAnalyzerStore();

  const { id, analysisResult, wordModifications = {}, sentenceRewrites = {} } = compareText;
  const isActive = activeCompareId === id;

  const readability = useMemo(() => {
    return calculateReadability(analysisResult, sentenceRewrites, wordModifications);
  }, [analysisResult, sentenceRewrites, wordModifications]);

  const handleWordClick = (si, wi) => {
    // Set this column as active
    setActiveCompareId(id);
    // Select word using the compare text's own analysis data
    const sentence = analysisResult?.sentences?.[si];
    const word = sentence?.words?.[wi];
    if (word) {
      useAnalyzerStore.setState({
        selectedWord: { sentenceIndex: si, wordIndex: wi, word },
        selectedCircle: null,
        selectedRewriteWord: null,
        infoPanel: 'word',
      });
    }
  };

  if (!analysisResult) return null;

  const { percent, knownWords, totalWords, translatedWords, cognateWords } = readability;
  const unknown = totalWords - knownWords - translatedWords - (cognateWords || 0);

  // Build stats description
  const parts = [];
  if (knownWords > 0) parts.push(`${knownWords} known`);
  if (cognateWords > 0) parts.push(`${cognateWords} cognate${cognateWords !== 1 ? 's' : ''}`);
  if (translatedWords > 0) parts.push(`${translatedWords} translated`);
  if (unknown > 0) parts.push(`${unknown} unknown`);
  const statsText = parts.length > 2
    ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]
    : parts.join(' and ');

  const barColor = percent >= 90 ? 'bg-[var(--brand)]' : percent >= 70 ? 'bg-[var(--brand-orange)]' : 'bg-[var(--color-unknown)]';
  const textColor = percent >= 90 ? 'text-[var(--brand)]' : percent >= 70 ? 'text-[var(--brand-orange)]' : 'text-[var(--color-unknown)]';

  // Label for the column
  const label = id === 'original' ? 'Current Text' : `Text ${id.replace('compare-', '')}`;

  return (
    <div
      className={`flex-1 min-w-0 flex flex-col border rounded-xl overflow-hidden transition-shadow ${
        isActive ? 'border-[var(--brand)] shadow-md ring-1 ring-[var(--brand)]' : 'border-slate-200'
      }`}
      onClick={() => setActiveCompareId(id)}
    >
      {/* Header label */}
      <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex-shrink-0">
        <span className="text-sm font-semibold text-slate-700">{label}</span>
      </div>

      {/* Mini stats bar */}
      <div className="px-4 py-2 border-b border-slate-100 flex-shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-sm font-semibold ${textColor}`}>{percent}%</span>
          <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${percent}%` }} />
          </div>
        </div>
        <p className="text-xs text-slate-500">
          {totalWords} {totalWords === 1 ? 'word' : 'words'}: {statsText}
        </p>
      </div>

      {/* Color-coded text — scrollable */}
      <div className="flex-1 overflow-y-auto p-4 text-sm leading-relaxed">
        {analysisResult.sentences.map((sentence, si) => (
          <span key={si}>
            {sentence.paragraphBreak && <><br /><br /></>}
            {sentence.words.map((word, wi) => {
              if (word.type === 'whitespace') return <span key={wi}>{word.text}</span>;
              if (word.type === 'punctuation') return <span key={wi}>{word.text}</span>;

              const modKey = `${si}_${wi}`;
              const mod = wordModifications[modKey];
              let status;
              if (mod?.type === 'replaced') {
                status = 'replaced';
              } else if (mod?.type === 'glossed') {
                status = 'glossed';
              } else {
                status = word.status;
              }

              const colorClass = getWordColorClass(status);
              const displayWord = mod?.type === 'replaced' ? mod.replacement : word.text;

              return (
                <span
                  key={wi}
                  className={`cursor-pointer rounded px-0.5 ${colorClass}`}
                  onClick={(e) => { e.stopPropagation(); handleWordClick(si, wi); }}
                >
                  {displayWord}
                </span>
              );
            })}
          </span>
        ))}
      </div>

      {/* Action buttons */}
      {!isReadOnly && (
        <div className="px-4 py-3 border-t border-slate-200 flex gap-2 flex-shrink-0 bg-white">
          <button
            onClick={(e) => { e.stopPropagation(); editCompareText(id); }}
            className="flex-1 py-1.5 text-sm bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 transition-colors font-medium"
          >
            Edit
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); promoteCompareText(id); }}
            className="flex-1 py-1.5 text-sm text-white rounded-lg transition-colors font-medium"
            style={{ backgroundColor: 'var(--brand)' }}
          >
            Use This Text
          </button>
        </div>
      )}
    </div>
  );
}
