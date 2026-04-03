import useAnalyzerStore from '../store/useAnalyzerStore';

export default function Header() {
  const { requestNewSession, toggleVocabLookup, whatIfMode, toggleWhatIfMode, analysisResult } = useAnalyzerStore();

  return (
    <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between flex-shrink-0">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold text-slate-800">Impuls Deutsch</h1>
        <span className="text-sm font-medium px-2 py-0.5 rounded" style={{ color: 'var(--brand)', backgroundColor: 'var(--brand-light)' }}>Text Analyzer</span>
      </div>

      <div className="flex items-center gap-3">
        {analysisResult && (
          <button
            onClick={toggleWhatIfMode}
            className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
              whatIfMode
                ? 'bg-amber-100 text-amber-800 border border-amber-300'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {whatIfMode ? 'Exit What If' : 'What If Mode'}
          </button>
        )}

        <button
          onClick={toggleVocabLookup}
          className="px-3 py-1.5 text-sm bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 transition-colors font-medium"
        >
          Vocabulary Lookup
        </button>

        <button
          onClick={requestNewSession}
          className="px-3 py-1.5 text-sm text-white rounded-lg transition-colors font-medium"
          style={{ backgroundColor: 'var(--brand)' }}
          onMouseEnter={e => e.target.style.backgroundColor = 'var(--brand-dark)'}
          onMouseLeave={e => e.target.style.backgroundColor = 'var(--brand)'}
        >
          New Session
        </button>
      </div>
    </header>
  );
}
