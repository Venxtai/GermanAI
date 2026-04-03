import { useState, useEffect, useMemo } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';

// Strip German articles from a word/phrase for insertion into sentences.
// The grammar-fix endpoint will add the correct article based on sentence context.
const ARTICLES = ['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer'];
function stripArticle(phrase) {
  const parts = phrase.trim().split(/\s+/);
  if (parts.length >= 2 && ARTICLES.includes(parts[0].toLowerCase())) {
    return parts.slice(1).join(' ');
  }
  return phrase;
}

// Chapter ranges for looking up which chapter a unit belongs to
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

/**
 * Map a unit ID to a short label:
 * "3" → "ID1 - Chapter 1 - Unit 3"
 * "B5" → "ID2 BLAU - Chapter 1 - Unit 5"
 * "O12" → "ID2 ORANGE - Chapter 1 - Unit 12"
 * Optional units get "(optional)" appended.
 */
function formatUnitLabel(unitId, optionalUnits) {
  if (!unitId) return 'Unknown';
  const isOptional = optionalUnits?.has(unitId);
  const suffix = isOptional ? ' (optional)' : '';

  if (unitId.startsWith('B')) {
    const num = parseInt(unitId.slice(1));
    const ch = ID2B_CH.find(c => num >= c.s && num <= c.e);
    return `ID2 BLAU - Chapter ${ch?.ch || '?'} - Unit ${num}${suffix}`;
  }
  if (unitId.startsWith('O')) {
    const num = parseInt(unitId.slice(1));
    const ch = ID2O_CH.find(c => num >= c.s && num <= c.e);
    return `ID2 ORANGE - Chapter ${ch?.ch || '?'} - Unit ${num}${suffix}`;
  }

  const num = parseInt(unitId);
  const ch = ID1_CH.find(c => num >= c.s && num <= c.e);
  return `ID1 - Chapter ${ch?.ch || '?'} - Unit ${num}${suffix}`;
}

/**
 * Get the set of optional unit IDs from the store (built lazily, cached).
 */
function getOptionalUnits() {
  const chapters = useAnalyzerStore.getState().chapters;
  if (!chapters) return new Set();
  const set = new Set();
  for (const book of Object.values(chapters)) {
    for (const ch of (book.chapters || [])) {
      for (const u of (ch.units || [])) {
        if (u.isOptional) set.add(u.id);
      }
    }
  }
  return set;
}

export default function InfoPanel() {
  const { infoPanel, selectedWord, selectedCircle, selectedRewriteWord, analysisResult } = useAnalyzerStore();

  if (infoPanel === 'rewriteWord' && selectedRewriteWord) {
    // For unchanged words in a rewritten sentence, delegate to the normal word panels
    const sentence = analysisResult?.sentences?.[selectedRewriteWord.sentenceIndex];
    if (!selectedRewriteWord.isChanged && sentence) {
      const origWord = sentence.words.find(w =>
        w.type === 'word' && w.text.toLowerCase() === selectedRewriteWord.wordText.toLowerCase()
      );
      if (origWord?.status === 'unknown') {
        const wi = sentence.words.indexOf(origWord);
        return <UnknownWordInfo word={origWord} sentenceIndex={selectedRewriteWord.sentenceIndex} wordIndex={wi} sentence={sentence} linkedGroup={null} />;
      }
      if (origWord?.status === 'known') {
        return <KnownWordInfo word={origWord} linkedGroup={null} />;
      }
    }
    return <RewriteWordInfo />;
  }
  if (infoPanel === 'word' && selectedWord) {
    return <WordInfo />;
  }
  if (infoPanel === 'circle' && selectedCircle) {
    return <CircleInfo />;
  }
  return <Instructions />;
}

function Instructions() {
  return (
    <div className="p-6 flex flex-col items-center justify-center h-full text-center">
      <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4" style={{ backgroundColor: 'var(--brand-light)' }}>
        <svg className="w-8 h-8" style={{ color: 'var(--brand)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
      </div>
      <h3 className="text-lg font-semibold text-slate-700 mb-2">How to Use</h3>
      <ol className="text-sm text-slate-500 text-left space-y-2 max-w-xs">
        <li><span className="font-medium text-slate-600">1.</span> Select all units you have covered in class from the left panel.</li>
        <li><span className="font-medium text-slate-600">2.</span> Enter or upload your German text in the center panel.</li>
        <li><span className="font-medium text-slate-600">3.</span> Press <span className="font-medium" style={{ color: 'var(--brand)' }}>Analyze</span> to see results.</li>
        <li><span className="font-medium text-slate-600">4.</span> Click any colored word or grammar circle to see details here.</li>
      </ol>
    </div>
  );
}

/**
 * Info panel for a word in a rewritten sentence.
 * Changed words: replacement context + Revert + vocab info.
 * Unchanged words: find matching original word and show its full info (including unknown word panel).
 */
function RewriteWordInfo() {
  const { selectedRewriteWord, setSentenceRewrite, analysisResult } = useAnalyzerStore();
  const [vocabInfo, setVocabInfo] = useState(null);
  const [vocabLoading, setVocabLoading] = useState(false);

  const sentenceIndex = selectedRewriteWord?.sentenceIndex;
  const wordText = selectedRewriteWord?.wordText;
  const isChanged = selectedRewriteWord?.isChanged;
  const rewrite = selectedRewriteWord?.rewrite;
  const sentence = analysisResult?.sentences?.[sentenceIndex];

  // ALL hooks must be called before any returns — React rules of hooks
  useEffect(() => {
    if (!wordText || !isChanged) return;
    setVocabLoading(true);

    // Lookup cascade: surface form → lemmatized forms → replacement phrase words
    fetch(`/api/analyzer/lookup?word=${encodeURIComponent(wordText)}`)
      .then(r => r.json())
      .then(async (data) => {
        if (data.entries?.length > 0) {
          setVocabInfo(data);
          setVocabLoading(false);
          return;
        }

        // Step 1b: If verb forms were found, use the lemma to look up the full entry
        // e.g., "mag" has verbForms with lemma "mögen"
        if (data.verbForms?.length > 0) {
          const lemma = data.verbForms[0].lemma;
          try {
            const res1b = await fetch(`/api/analyzer/lookup?word=${encodeURIComponent(lemma)}`);
            const data1b = await res1b.json();
            if (data1b.entries?.length > 0) {
              setVocabInfo(data1b);
              setVocabLoading(false);
              return;
            }
          } catch (_) {}
        }

        // Step 2: Try common German lemmatization patterns
        // "finde" → "finden", "kaufe" → "kaufen", "gehst" → "gehen"
        const wt = wordText.toLowerCase();
        const lemmaGuesses = [
          wt + 'n',                       // finde → finden
          wt + 'en',                      // find → finden
          wt.replace(/e$/, 'en'),         // finde → finden (redundant but safe)
          wt.replace(/st$/, 'en'),        // gehst → gehen
          wt.replace(/t$/, 'en'),         // geht → gehen
          wt.replace(/e$/, ''),           // große → groß
        ].filter((g, i, arr) => g !== wt && arr.indexOf(g) === i); // unique, not same as original

        for (const guess of lemmaGuesses) {
          try {
            const res2 = await fetch(`/api/analyzer/lookup?word=${encodeURIComponent(guess)}`);
            const data2 = await res2.json();
            if (data2.entries?.length > 0) {
              setVocabInfo(data2);
              setVocabLoading(false);
              return;
            }
          } catch (_) {}
        }

        // Step 3: Last resort — try other words from the replacement phrase
        const change = rewrite?.changes?.[0];
        const altWords = (change?.replacement || '').split(/\s+/).filter(Boolean);
        for (const alt of altWords) {
          if (alt.toLowerCase() === wt) continue;
          try {
            const res3 = await fetch(`/api/analyzer/lookup?word=${encodeURIComponent(alt)}`);
            const data3 = await res3.json();
            if (data3.entries?.length > 0) {
              setVocabInfo(data3);
              setVocabLoading(false);
              return;
            }
          } catch (_) {}
        }

        setVocabInfo(data); // Fall back to original (empty) result
        setVocabLoading(false);
      })
      .catch(() => setVocabLoading(false));
  }, [wordText, isChanged]);

  // Guard against null state
  if (!selectedRewriteWord || !wordText) return <Instructions />;

  const change = rewrite?.changes?.[0];
  const mergedEntries = vocabInfo?.entries ? mergeVocabEntries(vocabInfo.entries) : [];

  // Highlight changed words in the original and rewritten sentences
  function highlightSentence(text, wordsToHighlight) {
    if (!wordsToHighlight?.length) return <span>{text}</span>;
    // Build regex from words to highlight
    const escaped = wordsToHighlight.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part)
        ? <span key={i} className="font-bold text-blue-600">{part}</span>
        : <span key={i}>{part}</span>
    );
  }

  // Words to highlight: original word + all new words in rewritten
  const origWords = change?.original ? [change.original] : [];
  const newWords = [];
  if (rewrite?.rewritten && sentence) {
    const origSet = new Set(sentence.words.filter(w => w.type === 'word').map(w => w.text.toLowerCase()));
    for (const w of rewrite.rewritten.replace(/[.,!?;:]/g, '').split(/\s+/)) {
      if (w && !origSet.has(w.toLowerCase())) newWords.push(w);
    }
  }

  return (
    <div className="p-6 space-y-4">
      {/* Replacement context */}
      {isChanged && rewrite && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-blue-500" />
            <h3 className="text-base font-semibold text-blue-700">Word Replaced</h3>
          </div>

          <div className="text-sm bg-slate-50 p-3 rounded-lg space-y-1">
            <p className="text-slate-500">
              Original: {highlightSentence(rewrite.originalText, origWords)}
            </p>
            <p className="text-slate-700">
              Rewritten: {highlightSentence(rewrite.rewritten, newWords)}
            </p>
            {change && (
              <p className="text-xs text-slate-400 mt-1">
                {change.original} → {change.replacement}: {change.explanation}
              </p>
            )}
          </div>

          <button
            onClick={() => setSentenceRewrite(sentenceIndex, null)}
            className="w-full py-2 px-4 bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 transition-colors text-sm font-medium"
          >
            Revert to Original
          </button>
        </div>
      )}

      {/* Vocab info for the clicked changed word (merged entries) */}
      {vocabLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
          Looking up...
        </div>
      ) : mergedEntries.length > 0 ? (
        <div className="space-y-4">
          {mergedEntries.map((entry, i) => (
            <div key={i} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-[var(--brand)]" />
                <h3 className="text-base font-bold text-slate-800">{entry.word}</h3>
              </div>
              {wordText.toLowerCase() !== entry.word.toLowerCase().replace(/^(der|die|das)\s+/i, '') && (
                <p className="text-xs text-slate-400">as used in text: <span className="italic">{wordText}</span></p>
              )}
              {/* Multiple units listed together — same flex layout as InfoRow */}
              <div className="flex gap-2 text-sm">
                <span className="text-slate-400 font-medium min-w-24 flex-shrink-0">Studied in</span>
                <span className="text-slate-700">
                  {(entry.unitIds || [entry.unitId]).map((uid, j) => (
                    <span key={j}>
                      {j > 0 && <br />}
                      {formatUnitLabel(uid, getOptionalUnits())}
                    </span>
                  ))}
                </span>
              </div>
              {entry.translation && <InfoRow label="Translation" value={entry.translation} />}
              {entry.pos && <InfoRow label="Part of speech" value={entry.pos} />}
              {entry.cefr && <InfoRow label="CEFR Level" value={entry.cefr} />}
              {entry.frequency && <InfoRow label="Frequency" value={formatFrequency(entry.frequency)} />}
              <FullExampleSentences word={entry.word} pos={entry.pos} fallbackSentences={entry.modelSentences} />
            </div>
          ))}
        </div>
      ) : vocabInfo?.isUniversalFiller ? (
        <p className="text-sm text-slate-500">Universal filler word available in all units.</p>
      ) : isChanged ? (
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-[var(--brand)]" />
          <span className="text-sm text-slate-600">{wordText} — {/^\d+$/.test(wordText) ? 'number' : 'basic grammar word'}</span>
        </div>
      ) : null}
    </div>
  );
}

function WordInfo() {
  const {
    selectedWord, analysisResult, wordModifications,
    setWordModification, selectedUnits,
  } = useAnalyzerStore();

  const { sentenceIndex, wordIndex } = selectedWord;
  const sentence = analysisResult?.sentences?.[sentenceIndex];
  const word = sentence?.words?.[wordIndex];
  if (!word) return <Instructions />;

  const modKey = `${sentenceIndex}_${wordIndex}`;
  const mod = wordModifications[modKey];
  const effectiveStatus = mod?.type || word.status;

  // If the word is part of a linked group, find the group info
  const linkedGroup = word.linkedGroup
    ? analysisResult.linkedGroups?.find(g => g.id === word.linkedGroup)
    : null;

  if (effectiveStatus === 'replaced') {
    return <ReplacedWordInfo word={word} mod={mod} sentenceIndex={sentenceIndex} wordIndex={wordIndex} />;
  }
  if (effectiveStatus === 'glossed') {
    return <GlossedWordInfo word={word} mod={mod} sentenceIndex={sentenceIndex} wordIndex={wordIndex} />;
  }
  if (effectiveStatus === 'marked_known') {
    return <MarkedKnownWordInfo word={word} mod={mod} sentenceIndex={sentenceIndex} wordIndex={wordIndex} sentence={sentence} linkedGroup={linkedGroup} />;
  }
  if (word.status === 'known') {
    return <KnownWordInfo word={word} linkedGroup={linkedGroup} />;
  }
  return <UnknownWordInfo word={word} sentenceIndex={sentenceIndex} wordIndex={wordIndex} sentence={sentence} linkedGroup={linkedGroup} />;
}

function KnownWordInfo({ word, linkedGroup }) {
  const entry = word.entry;
  // Proper names ignore linked groups — show the name itself
  const isProperName = word.reason === 'proper_name' || word.isProperName;
  const effectiveLinkedGroup = isProperName ? null : linkedGroup;
  const displayWord = effectiveLinkedGroup?.lemma || entry?.word || word.lemma || word.text;

  // Fetch all example sentences across ALL units in the curriculum
  const [allSentences, setAllSentences] = useState(entry?.modelSentences || []);
  useEffect(() => {
    // Search for the base word (strip article for nouns)
    const searchWord = (entry?.word || word.lemma || word.text)
      .replace(/^(der|die|das)\s+/i, '').toLowerCase();
    if (!searchWord) return;
    const posParam = entry?.pos ? `&pos=${encodeURIComponent(entry.pos)}` : '';
    fetch(`/api/analyzer/example-sentences?word=${encodeURIComponent(searchWord)}${posParam}`)
      .then(r => r.json())
      .then(data => {
        if (data.sentences?.length > 0) setAllSentences(data.sentences);
      })
      .catch(() => {});
  }, [word.text]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <span className="w-3 h-3 rounded-full bg-[var(--brand)]" />
        <h3 className="text-lg font-bold text-[var(--brand)]">{displayWord}</h3>
      </div>

      {/* Show surface form if different from lemma */}
      {word.lemma && word.lemma.toLowerCase() !== word.text.toLowerCase() && (
        <p className="text-xs text-slate-400">as used in text: <span className="italic">{word.text}</span></p>
      )}

      {effectiveLinkedGroup && (
        <div className="text-sm text-slate-500 bg-slate-50 p-2 rounded">
          Linked verb form: {effectiveLinkedGroup.type?.replace('_', ' ')}
        </div>
      )}

      {entry && (
        <div className="space-y-3">
          <InfoRow label="Studied in" value={formatUnitLabel(entry.unitId, getOptionalUnits())} />
          <InfoRow label="Translation" value={entry.translation || 'N/A'} />
          <InfoRow label="Part of speech" value={entry.pos || 'N/A'} />
          {entry.cefr && <InfoRow label="CEFR Level" value={entry.cefr} />}
          {entry.frequency && (
            <InfoRow label="Frequency" value={formatFrequency(entry.frequency)} />
          )}

          <ExampleSentences sentences={allSentences} />
        </div>
      )}

      {word.reason === 'filler' && (
        <p className="text-sm text-slate-500">This is a universal filler word available in all units.</p>
      )}
      {word.reason === 'grammar_word' && (
        <p className="text-sm text-slate-500">{/^\d+$/.test(word.text) ? 'This is a number.' : 'This is a basic grammar word (article, pronoun, preposition).'}</p>
      )}
      {word.reason === 'contraction' && (
        <p className="text-sm text-slate-500">This is a contraction ({word.lemma || word.text}).</p>
      )}
      {word.reason === 'proper_name' && (
        <p className="text-sm text-slate-500">This is a proper name.</p>
      )}
    </div>
  );
}

function UnknownWordInfo({ word, sentenceIndex, wordIndex, sentence, linkedGroup }) {
  const {
    setWordModification, setSentenceRewrite, selectedUnits,
    wordAlternatives, setWordAlternatives, sentenceRewrites,
  } = useAnalyzerStore();
  const [applyingIdx, setApplyingIdx] = useState(null); // which alternative is being applied

  // Show the lemma (dictionary form), not the surface form
  const displayWord = linkedGroup?.lemma || word.lemma || word.text;

  // Auto-fetch alternatives on mount (cached per word position)
  const altKey = `${sentenceIndex}_${wordIndex}`;
  const cached = wordAlternatives[altKey];

  useEffect(() => {
    if (cached) return;
    const abortController = new AbortController();
    setWordAlternatives(sentenceIndex, wordIndex, { alternatives: [], loading: true });

    fetch('/api/analyzer/alternatives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sentence: sentence.text,
        unknownWord: word.text,
        unknownLemma: word.lemma || word.text,
        selectedUnits: Array.from(selectedUnits),
      }),
      signal: abortController.signal,
    })
      .then(r => r.json())
      .then(data => {
        if (!abortController.signal.aborted) {
          setWordAlternatives(sentenceIndex, wordIndex, {
            alternatives: data.alternatives || [],
            loading: false,
          });
        }
      })
      .catch((err) => {
        if (!abortController.signal.aborted) {
          setWordAlternatives(sentenceIndex, wordIndex, { alternatives: [], loading: false });
        }
      });
    return () => abortController.abort();
  }, [altKey]);

  const alternatives = cached?.alternatives || [];
  const altLoading = cached?.loading ?? true;

  const handleGloss = async () => {
    try {
      const res = await fetch('/api/analyzer/gloss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: word.lemma || word.text, sentenceContext: sentence.text }),
      });
      const data = await res.json();
      setWordModification(sentenceIndex, wordIndex, {
        type: 'glossed',
        originalWord: word.text,
        translation: data.translation,
      });
    } catch (err) {
      setWordModification(sentenceIndex, wordIndex, {
        type: 'glossed',
        originalWord: word.text,
        translation: '',
      });
    }
  };

  // Apply an alternative: use the CURRENT sentence version (may already be grammar-rewritten)
  const handleApplyAlternative = async (alt, idx) => {
    setApplyingIdx(idx);

    // Use the current rewritten version as the base, not the original
    const existingRewrite = sentenceRewrites[sentenceIndex];
    const currentText = existingRewrite?.rewritten || sentence.text;
    // Track the original for revert (always the true original)
    const trueOriginal = existingRewrite?.originalText || sentence.text;
    // Combine changes from previous rewrite + this word replacement
    const previousChanges = existingRewrite?.changes || [];
    // Preserve grammarFixed flag if a grammar rewrite was done before this word replacement
    const wasGrammarFixed = existingRewrite?.grammarFixed ||
      (existingRewrite && existingRewrite.targetStructure !== 'word-replacement');

    try {
      const res = await fetch('/api/analyzer/apply-replacement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sentence: currentText,
          originalWord: word.text,
          replacement: stripArticle(alt.alternative),
        }),
      });
      const data = await res.json();
      setSentenceRewrite(sentenceIndex, {
        rewritten: data.result || currentText.replace(word.text, alt.alternative),
        changes: [...previousChanges, { original: word.text, replacement: alt.alternative, explanation: alt.explanation }],
        originalText: trueOriginal,
        targetStructure: 'word-replacement',
        grammarFixed: wasGrammarFixed,
      });
    } catch (err) {
      setSentenceRewrite(sentenceIndex, {
        rewritten: currentText.replace(word.text, stripArticle(alt.alternative)),
        changes: [...previousChanges, { original: word.text, replacement: alt.alternative, explanation: alt.explanation }],
        originalText: trueOriginal,
        targetStructure: 'word-replacement',
        grammarFixed: wasGrammarFixed,
      });
    } finally {
      setApplyingIdx(null);
    }
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <span className="w-3 h-3 rounded-full bg-[var(--color-unknown)]" />
        <h3 className="text-lg font-bold text-[var(--color-unknown)]">{displayWord}</h3>
      </div>

      {/* Show surface form if different from lemma */}
      {word.lemma && word.lemma.toLowerCase() !== word.text.toLowerCase() && (
        <p className="text-xs text-slate-400">as used in text: <span className="italic">{word.text}</span></p>
      )}

      <p className="text-sm text-[var(--color-unknown)] font-medium">This word is unknown to the students.</p>

      {linkedGroup && (
        <div className="text-sm text-slate-500 bg-slate-50 p-2 rounded">
          Linked verb form: {linkedGroup.type?.replace('_', ' ')}
        </div>
      )}

      {/* Unit info — where this word IS taught */}
      {word.unitInfo?.inCurriculum && word.unitInfo.allOccurrences?.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">On the Vocabulary List in</p>
          {word.unitInfo.allOccurrences.map((occ, i) => (
            <div key={i} className={`text-sm p-2 rounded-lg ${
              occ.status === 'skipped' ? 'bg-amber-50 text-amber-700 border border-amber-200' :
              'bg-slate-50 text-slate-600 border border-slate-200'
            }`}>
              <span className="font-medium">{formatUnitLabel(occ.unitId, getOptionalUnits())}</span>
              {occ.status === 'skipped' && <span className="text-xs ml-1">(skipped)</span>}
              {occ.status === 'not_reached' && <span className="text-xs ml-1">(not reached yet)</span>}
            </div>
          ))}
        </div>
      ) : word.unitInfo?.inCurriculum ? (
        <div className={`text-sm p-3 rounded-lg ${
          word.unitInfo.status === 'skipped' ? 'bg-amber-50 text-amber-700 border border-amber-200' :
          'bg-slate-50 text-slate-600 border border-slate-200'
        }`}>
          This word is taught in <span className="font-medium">{formatUnitLabel(word.unitInfo.unitId, getOptionalUnits())}</span>
          {word.unitInfo.status === 'skipped' && ', which you skipped.'}
          {word.unitInfo.status === 'not_reached' && ', which you have not reached yet.'}
        </div>
      ) : (
        <p className="text-sm text-slate-500">This word does not appear in any unit's active vocabulary.</p>
      )}

      {/* All entries (where it appears across all books) */}
      {word.allEntries?.length > 0 && (
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Appears In Curriculum</p>
          <div className="space-y-1">
            {word.allEntries.map((e, i) => (
              <div key={i} className="text-sm text-slate-600 bg-slate-50 p-2 rounded">
                <span className="font-medium">{formatUnitLabel(e.unitId, getOptionalUnits())}</span>
                {e.translation && <span className="text-slate-500"> — {e.translation}</span>}
                <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${
                  e.isActive ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                }`}>
                  {e.isActive ? 'active' : 'passive'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Word alternatives from known vocabulary (auto-loaded) */}
      <div>
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Alternatives (Known Vocabulary)</p>
        {altLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
            Finding alternatives...
          </div>
        ) : alternatives.length > 0 ? (
          <div className="space-y-1.5">
            {alternatives.map((alt, i) => (
              <button
                key={i}
                onClick={() => handleApplyAlternative(alt, i)}
                disabled={applyingIdx !== null}
                className="w-full text-left p-2.5 rounded-lg bg-[var(--color-replaced-bg)] hover:brightness-95 transition-colors border border-blue-200 disabled:opacity-50"
              >
                <span className="text-sm font-semibold text-[var(--color-replaced)]">{alt.alternative}</span>
                <span className="text-xs text-blue-400 block mt-0.5">{alt.explanation}</span>
                {applyingIdx === i && <span className="text-xs text-blue-400 italic">Applying...</span>}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-400 italic">
            No alternatives found in known vocabulary.{' '}
            <button
              className="underline hover:text-slate-600"
              onClick={() => {
                setWordAlternatives(sentenceIndex, wordIndex, { alternatives: [], loading: true });
                fetch('/api/analyzer/alternatives', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    sentence: sentence.text,
                    unknownWord: word.text,
                    unknownLemma: word.lemma || word.text,
                    selectedUnits: Array.from(selectedUnits),
                    tryHarder: true,
                  }),
                })
                  .then(r => r.json())
                  .then(data => setWordAlternatives(sentenceIndex, wordIndex, { alternatives: data.alternatives || [], loading: false }))
                  .catch(() => setWordAlternatives(sentenceIndex, wordIndex, { alternatives: [], loading: false }));
              }}
            >
              Try again
            </button>
          </p>
        )}
      </div>

      {/* Action buttons */}
      <div className="space-y-2">
        <button
          onClick={handleGloss}
          className="w-full py-2 px-4 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors text-sm font-medium border border-gray-300"
        >
          Add Translation for Students
        </button>
        <button
          onClick={() => setWordModification(sentenceIndex, wordIndex, {
            type: 'marked_known',
            originalWord: word.text,
          })}
          className="w-full py-2 px-4 rounded-lg text-sm font-medium transition-colors border"
          style={{ backgroundColor: 'var(--brand-light)', color: 'var(--brand)', borderColor: 'var(--brand)' }}
        >
          Mark as Known
        </button>
      </div>
    </div>
  );
}

/**
 * A word that was originally unknown but manually marked as known by the teacher.
 * Shows teal color, full unknown word info, but with Mark as Unknown / Add Translation for Students buttons.
 */
function MarkedKnownWordInfo({ word, mod, sentenceIndex, wordIndex, sentence, linkedGroup }) {
  const { setWordModification, selectedUnits, wordAlternatives, setWordAlternatives, sentenceRewrites, setSentenceRewrite } = useAnalyzerStore();
  const [applyingIdx, setApplyingIdx] = useState(null);

  const displayWord = linkedGroup?.lemma || word.lemma || word.text;

  // Reuse cached alternatives
  const altKey = `${sentenceIndex}_${wordIndex}`;
  const cached = wordAlternatives[altKey];
  const alternatives = cached?.alternatives || [];
  const altLoading = cached?.loading ?? false;

  // Auto-fetch alternatives if not cached
  useEffect(() => {
    if (cached) return;
    const abortController = new AbortController();
    setWordAlternatives(sentenceIndex, wordIndex, { alternatives: [], loading: true });
    fetch('/api/analyzer/alternatives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sentence: sentence.text,
        unknownWord: word.text,
        unknownLemma: word.lemma || word.text,
        selectedUnits: Array.from(selectedUnits),
      }),
      signal: abortController.signal,
    })
      .then(r => r.json())
      .then(data => {
        if (!abortController.signal.aborted) {
          setWordAlternatives(sentenceIndex, wordIndex, { alternatives: data.alternatives || [], loading: false });
        }
      })
      .catch((err) => {
        if (!abortController.signal.aborted) {
          setWordAlternatives(sentenceIndex, wordIndex, { alternatives: [], loading: false });
        }
      });
    return () => abortController.abort();
  }, [altKey]);

  const handleApplyAlternative = async (alt, idx) => {
    setApplyingIdx(idx);
    const existingRewrite = sentenceRewrites[sentenceIndex];
    const currentText = existingRewrite?.rewritten || sentence.text;
    const trueOriginal = existingRewrite?.originalText || sentence.text;
    const previousChanges = existingRewrite?.changes || [];
    const wasGrammarFixed = existingRewrite?.grammarFixed || (existingRewrite && existingRewrite.targetStructure !== 'word-replacement');
    try {
      const res = await fetch('/api/analyzer/apply-replacement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sentence: currentText, originalWord: word.text, replacement: alt.alternative }),
      });
      const data = await res.json();
      setSentenceRewrite(sentenceIndex, {
        rewritten: data.result || currentText.replace(word.text, alt.alternative),
        changes: [...previousChanges, { original: word.text, replacement: alt.alternative, explanation: alt.explanation }],
        originalText: trueOriginal, targetStructure: 'word-replacement', grammarFixed: wasGrammarFixed,
      });
    } catch (err) {
      setSentenceRewrite(sentenceIndex, {
        rewritten: currentText.replace(word.text, stripArticle(alt.alternative)),
        changes: [...previousChanges, { original: word.text, replacement: alt.alternative, explanation: alt.explanation }],
        originalText: trueOriginal, targetStructure: 'word-replacement', grammarFixed: wasGrammarFixed,
      });
    } finally { setApplyingIdx(null); }
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <span className="w-3 h-3 rounded-full bg-[var(--brand)]" />
        <h3 className="text-lg font-bold text-[var(--brand)]">{displayWord}</h3>
      </div>

      {word.lemma && word.lemma.toLowerCase() !== word.text.toLowerCase() && (
        <p className="text-xs text-slate-400">as used in text: <span className="italic">{word.text}</span></p>
      )}

      <p className="text-sm text-[var(--brand)] font-medium">This word is unknown to the students but was marked as known.</p>

      {/* Unit info */}
      {word.unitInfo?.inCurriculum && word.unitInfo.allOccurrences?.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">On the Vocabulary List in</p>
          {word.unitInfo.allOccurrences.map((occ, i) => (
            <div key={i} className="text-sm p-2 rounded-lg bg-slate-50 text-slate-600 border border-slate-200">
              <span className="font-medium">{formatUnitLabel(occ.unitId, getOptionalUnits())}</span>
              {occ.status === 'skipped' && <span className="text-xs ml-1">(skipped)</span>}
              {occ.status === 'not_reached' && <span className="text-xs ml-1">(not reached yet)</span>}
            </div>
          ))}
        </div>
      )}

      {/* Alternatives */}
      {alternatives.length > 0 && (
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Alternatives (Known Vocabulary)</p>
          <div className="space-y-1.5">
            {alternatives.map((alt, i) => (
              <button key={i} onClick={() => handleApplyAlternative(alt, i)} disabled={applyingIdx !== null}
                className="w-full text-left p-2.5 rounded-lg bg-[var(--color-replaced-bg)] hover:brightness-95 transition-colors border border-blue-200 disabled:opacity-50">
                <span className="text-sm font-semibold text-[var(--color-replaced)]">{alt.alternative}</span>
                <span className="text-xs text-blue-400 block mt-0.5">{alt.explanation}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="space-y-2">
        <button
          onClick={() => {
            // Gloss it
            fetch('/api/analyzer/gloss', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ word: word.lemma || word.text, sentenceContext: sentence.text }),
            }).then(r => r.json()).then(data => {
              setWordModification(sentenceIndex, wordIndex, { type: 'glossed', originalWord: word.text, translation: data.translation });
            }).catch(() => {
              setWordModification(sentenceIndex, wordIndex, { type: 'glossed', originalWord: word.text, translation: '' });
            });
          }}
          className="w-full py-2 px-4 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors text-sm font-medium border border-gray-300"
        >
          Add Translation for Students
        </button>
        <button
          onClick={() => setWordModification(sentenceIndex, wordIndex, null)}
          className="w-full py-2 px-4 rounded-lg text-sm font-medium transition-colors border"
          style={{ backgroundColor: 'var(--color-unknown-bg)', color: 'var(--color-unknown)', borderColor: 'var(--color-unknown)' }}
        >
          Mark as Unknown
        </button>
      </div>
    </div>
  );
}

function ReplacedWordInfo({ word, mod, sentenceIndex, wordIndex }) {
  const { setWordModification } = useAnalyzerStore();

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <span className="w-3 h-3 rounded-full bg-blue-500" />
        <h3 className="text-lg font-bold text-blue-700">{mod.replacement}</h3>
      </div>

      <p className="text-sm text-slate-500">
        Replaced: <span className="line-through text-red-400">{mod.originalWord}</span> → <span className="text-blue-600 font-medium">{mod.replacement}</span>
      </p>

      {mod.source && (
        <div className="text-sm text-slate-600 space-y-1">
          <InfoRow label="From" value={formatUnitLabel(mod.source.unitId, getOptionalUnits())} />
          <InfoRow label="Translation" value={mod.source.translation} />
        </div>
      )}

      <button
        onClick={() => setWordModification(sentenceIndex, wordIndex, null)}
        className="w-full py-2 px-4 bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 transition-colors text-sm font-medium"
      >
        Revert to Original
      </button>
    </div>
  );
}

function GlossedWordInfo({ word, mod, sentenceIndex, wordIndex }) {
  const { setWordModification } = useAnalyzerStore();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(mod.translation || '');
  const [vocabInfo, setVocabInfo] = useState(null);

  const displayWord = word.lemma || mod.originalWord;

  // Fetch vocab info
  useEffect(() => {
    const searchWord = word.lemma || mod.originalWord;
    if (!searchWord) return;
    fetch(`/api/analyzer/lookup?word=${encodeURIComponent(searchWord)}`)
      .then(r => r.json())
      .then(data => setVocabInfo(data))
      .catch(() => {});
  }, [word.lemma, mod.originalWord]);

  const mergedEntries = vocabInfo?.entries ? mergeVocabEntries(vocabInfo.entries) : [];

  const handleSave = () => {
    setWordModification(sentenceIndex, wordIndex, {
      ...mod,
      translation: editValue.trim(),
    });
    setEditing(false);
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <span className="w-3 h-3 rounded-full bg-gray-400" />
        <h3 className="text-lg font-bold text-gray-600">{displayWord}</h3>
      </div>

      {word.lemma && word.lemma.toLowerCase() !== mod.originalWord.toLowerCase() && (
        <p className="text-xs text-slate-400">as used in text: <span className="italic">{mod.originalWord}</span></p>
      )}

      <p className="text-sm text-gray-500 font-medium">This word is unknown to the students and was translated.</p>

      {/* Gloss translation + override */}
      {editing ? (
        <div className="space-y-2">
          <input
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setEditing(false); }}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 text-sm"
            style={{ '--tw-ring-color': 'var(--brand)' }}
            autoFocus
            placeholder="Enter translation"
          />
          <div className="flex gap-2">
            <button onClick={handleSave} className="flex-1 py-1.5 text-white rounded-lg text-sm font-medium" style={{ backgroundColor: 'var(--brand)' }}>Save</button>
            <button onClick={() => setEditing(false)} className="flex-1 py-1.5 bg-slate-100 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-200">Cancel</button>
          </div>
        </div>
      ) : (
        <>
          {mod.translation && (
            <div className="bg-gray-50 p-2 rounded border border-gray-200">
              <InfoRow label="Translation" value={mod.translation} />
            </div>
          )}
          <button
            onClick={() => { setEditValue(mod.translation || ''); setEditing(true); }}
            className="w-full py-2 px-4 bg-slate-50 text-slate-500 rounded-lg hover:bg-slate-100 transition-colors text-sm font-medium border border-slate-200"
          >
            {mod.translation ? 'Override Translation' : 'Add Translation'}
          </button>
        </>
      )}

      {/* Unit info from the word's analysis data */}
      {word.unitInfo?.inCurriculum && word.unitInfo.allOccurrences?.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">On the Vocabulary List in</p>
          {word.unitInfo.allOccurrences.map((occ, i) => (
            <div key={i} className="text-sm p-2 rounded-lg bg-slate-50 text-slate-600 border border-slate-200">
              <span className="font-medium">{formatUnitLabel(occ.unitId, getOptionalUnits())}</span>
              {occ.status === 'skipped' && <span className="text-xs ml-1">(skipped)</span>}
              {occ.status === 'not_reached' && <span className="text-xs ml-1">(not reached yet)</span>}
            </div>
          ))}
        </div>
      )}

      {/* Vocab details from lookup */}
      {mergedEntries.length > 0 && (
        <div className="space-y-2">
          {mergedEntries.map((entry, i) => (
            <div key={i} className="space-y-1">
              <div className="flex gap-2 text-sm">
                <span className="text-slate-400 font-medium min-w-24 flex-shrink-0">Studied in</span>
                <span className="text-slate-700">
                  {(entry.unitIds || [entry.unitId]).map((uid, j) => (
                    <span key={j}>{j > 0 && <br />}{formatUnitLabel(uid, getOptionalUnits())}</span>
                  ))}
                </span>
              </div>
              {entry.translation && <InfoRow label="Translation" value={entry.translation} />}
              {entry.pos && <InfoRow label="Part of speech" value={entry.pos} />}
              {entry.cefr && <InfoRow label="CEFR Level" value={entry.cefr} />}
              {entry.frequency && <InfoRow label="Frequency" value={formatFrequency(entry.frequency)} />}
              <FullExampleSentences word={entry.word} pos={entry.pos} fallbackSentences={entry.modelSentences} />
            </div>
          ))}
        </div>
      )}

      <button
        onClick={() => setWordModification(sentenceIndex, wordIndex, null)}
        className="w-full py-2 px-4 bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 transition-colors text-sm font-medium"
      >
        Remove Translation
      </button>
    </div>
  );
}

function CircleInfo() {
  const {
    selectedCircle, analysisResult, sentenceRewrites, setSentenceRewrite, selectedUnits,
  } = useAnalyzerStore();
  const [isRewriting, setIsRewriting] = useState(false);

  const si = selectedCircle.sentenceIndex;
  const sentence = analysisResult?.sentences?.[si];
  if (!sentence) return <Instructions />;

  const rewrite = sentenceRewrites[si];
  const grammar = sentence.grammar;
  const isWordReplacement = rewrite?.targetStructure === 'word-replacement';
  const isGrammarRewrite = rewrite && !isWordReplacement;
  const grammarWasFixed = rewrite?.grammarFixed || isGrammarRewrite;

  const handleRewrite = async (option, sent, sentIdx) => {
    setIsRewriting(true);
    // Use the current rewritten version if word replacements were made
    const existingRewrite = sentenceRewrites[sentIdx];
    const currentText = existingRewrite?.rewritten || sent.text;
    const trueOriginal = existingRewrite?.originalText || sent.text;
    const previousChanges = existingRewrite?.changes || [];
    try {
      const res = await fetch('/api/analyzer/rewrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sentence: currentText,
          targetStructure: option.targetStructure || option.label,
          issueDescription: option.label,
          selectedUnits: Array.from(selectedUnits),
          priorReplacements: previousChanges.filter(c => c.original && c.replacement),
        }),
      });
      const data = await res.json();
      setSentenceRewrite(sentIdx, {
        ...data,
        originalText: trueOriginal,
        changes: [...previousChanges, ...(data.changes || [])],
        targetStructure: option.label,
        grammarFixed: true,
      });
    } catch (err) {
      console.error('Rewrite failed:', err);
    } finally {
      setIsRewriting(false);
    }
  };

  // Current display text (rewritten or original)
  const currentText = rewrite?.rewritten || sentence.text;

  // ── GRAMMAR FIXED: blue circle with full rewrite context ──
  // Shows for direct grammar rewrites AND stacked grammar+word rewrites
  if (grammarWasFixed) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-blue-500" />
          <h3 className="text-base font-semibold text-blue-700">Sentence Rewritten</h3>
        </div>

        {/* Original sentence with detected structures */}
        <p className="text-sm text-slate-600 italic bg-slate-50 p-2 rounded">{rewrite.originalText}</p>

        {grammar.structures?.length > 0 && (
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Structures Detected</p>
            {grammar.structures.map((s, i) => (
              <p key={i} className={`text-sm ${s.allowed ? 'text-[var(--brand)]' : 'text-[var(--color-unknown)]'}`}>
                {s.type}: {s.value} {s.allowed ? '\u2713' : '\u2717'}
              </p>
            ))}
          </div>
        )}

        {/* Issue description */}
        {grammar.issues?.map((issue, i) => (
          <p key={i} className="text-sm text-[var(--color-unknown)]">{issue.description}</p>
        ))}

        {/* Rewritten version */}
        <div className="text-sm bg-blue-50 p-3 rounded-lg border border-blue-200 space-y-1">
          <p className="text-blue-700 font-medium">Rewritten: <span className="italic">{rewrite.rewritten}</span></p>
          {rewrite.changes?.map((c, i) => (
            <p key={i} className="text-xs text-blue-500">
              {c.original} → {c.replacement}: {c.explanation}
            </p>
          ))}
        </div>

        {/* Structures of the rewritten sentence (all should be OK now) */}
        {grammar.structures?.length > 0 && (
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Structures Used</p>
            {grammar.structures.filter(s => s.allowed).map((s, i) => (
              <p key={i} className="text-sm text-[var(--brand)]">
                {s.type}: {s.value} {'\u2713'}
              </p>
            ))}
          </div>
        )}

        {/* Try different rewrite options — filter out the one already applied */}
        {(() => {
          const appliedLabel = rewrite.targetStructure?.toLowerCase();
          const remainingOptions = (grammar.issues || []).flatMap(issue =>
            (issue.rewriteOptions || []).filter(opt =>
              opt.label.toLowerCase() !== appliedLabel
            )
          );
          if (remainingOptions.length === 0) return null;
          return (
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Try a Different Rewrite</p>
            {remainingOptions.map((opt, j) => (
                  <button
                    key={j}
                    onClick={() => handleRewrite(opt, sentence, si)}
                    disabled={isRewriting}
                    className="w-full text-left p-2 rounded-lg bg-blue-50 hover:bg-blue-100 transition-colors border border-blue-200 text-sm disabled:opacity-50"
                  >
                    {isRewriting ? 'Rewriting...' : opt.label}
                  </button>
            ))}
          </div>
          );
        })()}

        <button
          onClick={() => setSentenceRewrite(si, null)}
          className="w-full py-2 px-4 bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 transition-colors text-sm font-medium"
        >
          Revert to Original
        </button>
      </div>
    );
  }

  // ── GRAMMAR ISSUE (no rewrite yet): red circle ──
  if (grammar.status === 'issue') {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-[var(--color-unknown)]" />
          <h3 className="text-base font-semibold text-[var(--color-unknown)]">Grammar Issue</h3>
        </div>

        <p className="text-sm text-slate-600 italic bg-slate-50 p-2 rounded">{sentence.text}</p>

        {grammar.structures?.length > 0 && (
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Structures Detected</p>
            {grammar.structures.map((s, i) => (
              <p key={i} className={`text-sm ${s.allowed ? 'text-[var(--brand)]' : 'text-[var(--color-unknown)]'}`}>
                {s.type}: {s.value} {s.allowed ? '\u2713' : '\u2717'}
              </p>
            ))}
          </div>
        )}

        {grammar.issues?.map((issue, i) => (
          <div key={i} className="space-y-2">
            <p className="text-sm text-[var(--color-unknown)]">{issue.description}</p>
            {issue.suggestion && (
              <p className="text-sm text-slate-500">Suggestion: {issue.suggestion}</p>
            )}
            {issue.rewriteOptions?.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Rewrite Options</p>
                {issue.rewriteOptions.map((opt, j) => (
                  <button
                    key={j}
                    onClick={() => handleRewrite(opt, sentence, si)}
                    disabled={isRewriting}
                    className="w-full text-left p-2 rounded-lg bg-blue-50 hover:bg-blue-100 transition-colors border border-blue-200 text-sm disabled:opacity-50"
                  >
                    {isRewriting ? 'Rewriting...' : opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  // ── GRAMMAR OK: green circle (also used for word-replacement rewrites) ──
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <span className="w-3 h-3 rounded-full bg-[var(--brand)]" />
        <h3 className="text-base font-semibold text-[var(--brand)]">Grammar OK</h3>
      </div>

      <p className="text-sm text-slate-600 italic bg-slate-50 p-2 rounded">{currentText}</p>

      {grammar.structures?.length > 0 && (
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Structures Used</p>
          {grammar.structures.map((s, i) => (
            <p key={i} className="text-sm text-[var(--brand)]">
              {s.type}: {s.value} {'\u2713'}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Collapsible example sentences grouped by unit.
 * Shows unit labels as clickable headers; click to expand/collapse.
 */
function ExampleSentences({ sentences }) {
  const [expandedUnits, setExpandedUnits] = useState({});

  if (!sentences || sentences.length === 0) return null;

  // Group sentences by unitId
  const grouped = {};
  for (const ms of sentences) {
    const uid = ms.unitId || '?';
    if (!grouped[uid]) grouped[uid] = [];
    // Deduplicate
    if (!grouped[uid].some(s => s.sentence === ms.sentence)) {
      grouped[uid].push(ms);
    }
  }

  const unitIds = Object.keys(grouped);

  const toggle = (uid) => {
    setExpandedUnits(prev => ({ ...prev, [uid]: !prev[uid] }));
  };

  return (
    <div>
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">Example Sentences</p>
      <div className="space-y-1">
        {unitIds.map(uid => {
          const isOpen = expandedUnits[uid] ?? (unitIds.length === 1); // auto-open if only one unit
          const sents = grouped[uid];
          return (
            <div key={uid}>
              <button
                onClick={() => toggle(uid)}
                className="w-full flex items-center gap-1.5 text-left py-1 px-2 rounded hover:bg-slate-50 transition-colors"
              >
                <span className="text-xs text-slate-400">{isOpen ? '\u25BC' : '\u25B6'}</span>
                <span className="text-xs font-medium text-slate-500">{formatUnitLabel(uid, getOptionalUnits())}</span>
                <span className="text-xs text-slate-300 ml-auto">{sents.length}</span>
              </button>
              {isOpen && (
                <div className="ml-4 space-y-1 mb-1">
                  {sents.map((ms, j) => (
                    <p key={j} className="text-sm text-slate-600 bg-slate-50 p-2 rounded italic">
                      {ms.sentence}
                    </p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Wrapper that fetches example sentences from ALL units, then renders ExampleSentences.
 */
function FullExampleSentences({ word, pos, fallbackSentences }) {
  const [sentences, setSentences] = useState(fallbackSentences || []);
  useEffect(() => {
    const searchWord = (word || '').replace(/^(der|die|das)\s+/i, '').toLowerCase();
    if (!searchWord) return;
    const posParam = pos ? `&pos=${encodeURIComponent(pos)}` : '';
    fetch(`/api/analyzer/example-sentences?word=${encodeURIComponent(searchWord)}${posParam}`)
      .then(r => r.json())
      .then(data => {
        if (data.sentences?.length > 0) setSentences(data.sentences);
      })
      .catch(() => {});
  }, [word]);
  return <ExampleSentences sentences={sentences} />;
}

function InfoRow({ label, value }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="text-slate-400 font-medium min-w-24">{label}</span>
      <span className="text-slate-700">{value}</span>
    </div>
  );
}

function formatFrequency(freq) {
  if (!freq) return 'N/A';
  const f = parseInt(freq);
  if (f <= 100) return 'Top 100';
  if (f <= 1000) return `Top ${Math.ceil(f / 100) * 100}`;
  if (f <= 5000) return `Top ${Math.ceil(f / 500) * 500}`;
  return 'Top 5,000+';
}

/**
 * Merge vocab entries that refer to the same word/meaning.
 * Entries with the same base meaning get merged (combined units, combined model sentences).
 * Entries with completely different meanings stay separate.
 */
function mergeVocabEntries(entries) {
  if (!entries || entries.length <= 1) return entries;

  // Group by similarity: compare translations
  const groups = [];

  for (const entry of entries) {
    const entryTranslations = new Set(
      (entry.translation || '').split(/[;,]/).map(t => t.trim().toLowerCase()).filter(Boolean)
    );

    // Try to find an existing group to merge with
    let merged = false;
    for (const group of groups) {
      const groupTranslations = new Set(
        (group.translation || '').split(/[;,]/).map(t => t.trim().toLowerCase()).filter(Boolean)
      );

      // Merge if: same base word (ignoring articles), OR overlapping translations
      const sameWord = group.word.replace(/^(der|die|das)\s+/i, '').toLowerCase() ===
                       entry.word.replace(/^(der|die|das)\s+/i, '').toLowerCase();
      const hasOverlap = [...entryTranslations].some(t => groupTranslations.has(t));
      if (sameWord || hasOverlap) {
        // Merge: add unit, combine translations, combine model sentences
        group.unitIds.push(entry.unitId);
        // Add new translations not already present
        const existingTrans = group.translation.toLowerCase();
        const newTrans = (entry.translation || '').split(/[;,]/).map(t => t.trim()).filter(t =>
          t && !existingTrans.includes(t.toLowerCase())
        );
        if (newTrans.length > 0) {
          group.translation += '; ' + newTrans.join(', ');
        }
        // Combine model sentences
        group.modelSentences = [
          ...(group.modelSentences || []),
          ...(entry.modelSentences || []),
        ];
        // Keep the more complete POS / CEFR / frequency
        if (!group.pos && entry.pos) group.pos = entry.pos;
        if (entry.pos && entry.pos !== group.pos) group.pos = entry.pos; // prefer ADJ over ADV etc.
        if (!group.cefr && entry.cefr) group.cefr = entry.cefr;
        if (!group.frequency && entry.frequency) group.frequency = entry.frequency;
        merged = true;
        break;
      }
    }

    if (!merged) {
      // New group — different meaning
      groups.push({
        ...entry,
        unitIds: [entry.unitId],
        modelSentences: [...(entry.modelSentences || [])],
      });
    }
  }

  return groups;
}
