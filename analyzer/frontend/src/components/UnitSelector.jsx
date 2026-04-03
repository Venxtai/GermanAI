import { useState } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';

export default function UnitSelector() {
  const {
    chapters, selectedUnits, whatIfMode, whatIfUnits,
    toggleUnit, selectAllInBook, deselectAllInBook,
    selectAllInChapter, deselectAllInChapter,
  } = useAnalyzerStore();

  const effectiveUnits = whatIfMode ? whatIfUnits : selectedUnits;

  if (!chapters) {
    return <div className="p-4 text-slate-400 text-sm">Loading units...</div>;
  }

  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">Units Covered</h2>
        <span className="text-xs text-slate-400">{effectiveUnits?.size || 0} selected</span>
      </div>

      {whatIfMode && (
        <div className="mb-3 p-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
          What If mode: toggle units to see how the analysis changes instantly.
        </div>
      )}

      {Object.entries(chapters).map(([bookId, book]) => (
        <BookSection
          key={bookId}
          bookId={bookId}
          book={book}
          effectiveUnits={effectiveUnits}
          toggleUnit={toggleUnit}
          selectAllInBook={selectAllInBook}
          deselectAllInBook={deselectAllInBook}
          selectAllInChapter={selectAllInChapter}
          deselectAllInChapter={deselectAllInChapter}
        />
      ))}
    </div>
  );
}

function BookSection({
  bookId, book, effectiveUnits, toggleUnit,
  selectAllInBook, deselectAllInBook,
  selectAllInChapter, deselectAllInChapter,
}) {
  const [expanded, setExpanded] = useState(bookId === 'ID1');

  const allBookUnits = book.chapters?.flatMap(ch => ch.units?.map(u => u.id) || []) || [];
  const allSelected = allBookUnits.length > 0 && allBookUnits.every(id => effectiveUnits?.has(id));
  const someSelected = allBookUnits.some(id => effectiveUnits?.has(id));

  return (
    <div className="mb-2">
      <div className="flex items-center gap-1.5 py-1.5 group">
        <button onClick={() => setExpanded(!expanded)} className="text-slate-400 hover:text-slate-600 w-4 text-xs">
          {expanded ? '\u25BC' : '\u25B6'}
        </button>
        <input
          type="checkbox"
          checked={allSelected}
          ref={el => { if (el) el.indeterminate = someSelected && !allSelected; }}
          onChange={() => allSelected ? deselectAllInBook(bookId) : selectAllInBook(bookId)}
          className="rounded w-3.5 h-3.5 accent-[var(--brand)]"
        />
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-sm font-semibold text-slate-700 hover:text-slate-900 flex-1 text-left"
        >
          {book.title}
        </button>
      </div>

      {expanded && book.chapters?.map(ch => (
        <ChapterSection
          key={ch.chapter}
          bookId={bookId}
          chapter={ch}
          effectiveUnits={effectiveUnits}
          toggleUnit={toggleUnit}
          selectAllInChapter={selectAllInChapter}
          deselectAllInChapter={deselectAllInChapter}
        />
      ))}
    </div>
  );
}

function ChapterSection({
  bookId, chapter, effectiveUnits, toggleUnit,
  selectAllInChapter, deselectAllInChapter,
}) {
  const [expanded, setExpanded] = useState(false);

  const unitIds = chapter.units?.map(u => u.id) || [];
  const allSelected = unitIds.length > 0 && unitIds.every(id => effectiveUnits?.has(id));
  const someSelected = unitIds.some(id => effectiveUnits?.has(id));

  return (
    <div className="ml-5 mb-1">
      <div className="flex items-center gap-1.5 py-1">
        <button onClick={() => setExpanded(!expanded)} className="text-slate-400 hover:text-slate-600 w-4 text-xs">
          {expanded ? '\u25BC' : '\u25B6'}
        </button>
        <input
          type="checkbox"
          checked={allSelected}
          ref={el => { if (el) el.indeterminate = someSelected && !allSelected; }}
          onChange={() => allSelected ? deselectAllInChapter(bookId, chapter) : selectAllInChapter(bookId, chapter)}
          className="rounded w-3.5 h-3.5 accent-[var(--brand)]"
        />
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-slate-600 hover:text-slate-800 flex-1 text-left leading-tight"
        >
          <span className="font-medium">Ch. {chapter.chapter}:</span>{' '}
          <span className="text-slate-500">{chapter.title}</span>
        </button>
      </div>

      {expanded && (
        <div className="ml-5 space-y-0.5">
          {chapter.units?.map(unit => (
            <label key={unit.id} className={`flex items-center gap-1.5 py-0.5 cursor-pointer hover:bg-slate-50 rounded px-1 -mx-1 ${unit.isOptional ? 'opacity-75' : ''}`}>
              <input
                type="checkbox"
                checked={effectiveUnits?.has(unit.id) || false}
                onChange={() => toggleUnit(unit.id)}
                className="rounded w-3 h-3 accent-[var(--brand)]"
              />
              <span className={`text-xs ${unit.isOptional ? 'text-slate-400 italic' : 'text-slate-600'}`}>
                Unit {unit.id}
                {(unit.name || unit.topics?.[0]) && (
                  <span className={unit.isOptional ? 'text-slate-400 ml-1' : 'text-slate-500 ml-1'}>— {unit.name || unit.topics[0]}</span>
                )}
                {unit.isOptional && <span className="text-slate-400 ml-1">(optional)</span>}
              </span>
              {unit.vocabCount > 0 && (
                <span className="text-xs text-slate-300 ml-auto">{unit.vocabCount}w</span>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
