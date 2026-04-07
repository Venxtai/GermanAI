import { useState } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';

export default function VocabLookup() {
  const { toggleVocabLookup } = useAnalyzerStore();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/analyzer/lookup?word=${encodeURIComponent(query.trim())}`);
      const data = await res.json();
      setResults(data);
    } catch (err) {
      console.error('Lookup failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSearch();
    if (e.key === 'Escape') toggleVocabLookup();
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={toggleVocabLookup}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800">Vocabulary Lookup</h2>
          <button
            onClick={toggleVocabLookup}
            className="text-slate-400 hover:text-slate-600 text-xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* Search */}
        <div className="p-4 border-b border-slate-100">
          <div className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a German word..."
              className="flex-1 px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 text-sm"
              style={{ '--tw-ring-color': 'var(--brand)' }}
              autoFocus
            />
            <button
              onClick={handleSearch}
              disabled={loading || !query.trim()}
              className="px-4 py-2 text-white rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
              style={{ backgroundColor: 'var(--brand)' }}
              onMouseEnter={e => { if (!e.target.disabled) e.target.style.backgroundColor = 'var(--brand-dark)'; }}
              onMouseLeave={e => e.target.style.backgroundColor = 'var(--brand)'}
            >
              {loading ? '...' : 'Search'}
            </button>
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto p-4">
          {results === null && (
            <p className="text-sm text-slate-400 text-center py-8">
              Search for any German word to see which unit it appears in.
            </p>
          )}

          {results && results.entries.length === 0 && results.verbForms.length === 0 && !results.isUniversalFiller && (
            <p className="text-sm text-slate-500 text-center py-8">
              "{results.word}" was not found in the curriculum.
            </p>
          )}

          {results?.isUniversalFiller && (
            <div className="mb-3 p-3 bg-green-50 rounded-lg border border-green-200">
              <p className="text-sm text-green-700 font-medium">Universal filler word</p>
              <p className="text-xs text-green-600">Available in all units as a discourse marker.</p>
            </div>
          )}

          {results?.entries.length > 0 && (
            <div className="space-y-3">
              {results.entries.map((entry, i) => (
                <VocabEntry key={i} entry={entry} />
              ))}
            </div>
          )}

          {results?.verbForms.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Verb Forms</p>
              {results.verbForms.slice(0, 10).map((vf, i) => (
                <div key={i} className="text-sm text-slate-600 py-1">
                  <span className="font-medium">{vf.fullForm}</span>
                  <span className="text-slate-400"> — {vf.lemma} ({vf.tense}, {vf.person})</span>
                  <span className="text-xs ml-1" style={{ color: getBookColor(vf.unitId) }}>
                    {formatUnitLabel(vf.unitId)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Book colors matching the Buddy
const BOOK_COLORS = { ID1: '#008899', ID2B: '#00528a', ID2O: '#ed6c28' };

function getBookColor(unitId) {
  if (!unitId) return '#64748b';
  if (String(unitId).startsWith('B')) return BOOK_COLORS.ID2B;
  if (String(unitId).startsWith('O')) return BOOK_COLORS.ID2O;
  return BOOK_COLORS.ID1;
}

// Chapter ranges
const ID1_CH = [
  { ch: 1, s: 1, e: 15 }, { ch: 2, s: 16, e: 26 }, { ch: 3, s: 27, e: 37 }, { ch: 4, s: 38, e: 52 },
  { ch: 5, s: 53, e: 67 }, { ch: 6, s: 68, e: 79 }, { ch: 7, s: 80, e: 93 }, { ch: 8, s: 94, e: 104 },
];
const ID2B_CH = [
  { ch: 1, s: 1, e: 14 }, { ch: 2, s: 15, e: 26 }, { ch: 3, s: 27, e: 37 }, { ch: 4, s: 38, e: 52 },
];
const ID2O_CH = [
  { ch: 1, s: 1, e: 17 }, { ch: 2, s: 18, e: 29 }, { ch: 3, s: 30, e: 41 }, { ch: 4, s: 42, e: 52 },
];

function formatUnitLabel(unitId) {
  if (!unitId) return 'Unknown';
  const id = String(unitId);
  if (id.startsWith('B')) {
    const num = parseInt(id.slice(1));
    const ch = ID2B_CH.find(c => num >= c.s && num <= c.e);
    return `ID2 BLAU - Chapter ${ch?.ch || '?'} - Unit ${num}`;
  }
  if (id.startsWith('O')) {
    const num = parseInt(id.slice(1));
    const ch = ID2O_CH.find(c => num >= c.s && num <= c.e);
    return `ID2 ORANGE - Chapter ${ch?.ch || '?'} - Unit ${num}`;
  }
  const num = parseInt(id);
  const ch = ID1_CH.find(c => num >= c.s && num <= c.e);
  return `ID1 - Chapter ${ch?.ch || '?'} - Unit ${num}`;
}

function formatFrequencyShort(freq) {
  if (!freq) return null;
  const f = parseInt(freq);
  if (isNaN(f)) return null;
  if (f <= 1000) return `Top ${Math.ceil(f / 100) * 100}`;
  if (f <= 5000) return `Top ${Math.ceil(f / 500) * 500}`;
  return 'Top 5,000+';
}

function VocabEntry({ entry }) {
  const bookColor = getBookColor(entry.unitId);
  const label = formatUnitLabel(entry.unitId);
  const freqShort = formatFrequencyShort(entry.frequency);

  return (
    <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="font-medium text-slate-800">{entry.word}</span>
        <span
          className="text-xs px-2 py-0.5 rounded-full whitespace-nowrap flex-shrink-0"
          style={{ backgroundColor: bookColor + '18', color: bookColor, border: `1px solid ${bookColor}40` }}
        >
          {label}
        </span>
      </div>
      {entry.translation && (
        <p className="text-sm text-slate-600">{entry.translation}</p>
      )}
      <div className="flex gap-3 mt-1.5 text-xs text-slate-400">
        {entry.pos && <span>{entry.pos}</span>}
        {entry.cefr && <span>CEFR: {entry.cefr}</span>}
        {freqShort && <span>Frequency: {freqShort}</span>}
        <span className={entry.isActive ? 'text-green-600' : 'text-yellow-600'}>
          {entry.isActive ? 'Active' : 'Passive'}
        </span>
      </div>
    </div>
  );
}
