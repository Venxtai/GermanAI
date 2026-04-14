/**
 * Calculate readability stats from an analysis result, accounting for
 * sentence rewrites and word modifications.
 *
 * Returns { percent, knownWords, totalWords, grammarIssues, translatedWords, cognateWords,
 *           uniqueCognates, uniqueUnknown }
 */
export function calculateReadability(analysisResult, sentenceRewrites = {}, wordModifications = {}) {
  if (!analysisResult) {
    return { percent: 100, knownWords: 0, totalWords: 0, grammarIssues: 0, translatedWords: 0, cognateWords: 0, uniqueCognates: 0, uniqueUnknown: 0 };
  }

  let total = 0;
  let known = 0;
  let translated = 0;
  let cognates = 0;
  let grammarIssues = 0;
  const cognateSet = new Set();
  const unknownSet = new Set();

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
      // Count words in rewritten sentence -- all replacement words are "known" by design
      const origWordSet = new Set(
        sentence.words.filter(w => w.type === 'word').map(w => w.text.toLowerCase())
      );
      const rewrittenWords = rewrite.rewritten
        .replace(/[.,!?;:"\u201C\u201D\u201E\u2018\u2019()\[\]{}\u2013\u2014\u2026]/g, '')
        .split(/\s+/)
        .filter(Boolean);

      for (const rw of rewrittenWords) {
        total++;
        const rwLower = rw.toLowerCase();
        if (!origWordSet.has(rwLower)) {
          known++;
        } else {
          const origWord = sentence.words.find(w =>
            w.type === 'word' && w.text.toLowerCase() === rwLower
          );
          if (origWord?.status === 'known') {
            known++;
          } else if (origWord?.status === 'cognate') {
            known++;
            cognates++;
            cognateSet.add((origWord.lemma || origWord.text).toLowerCase());
          }
        }
      }
    } else {
      // No rewrite -- use original word statuses
      for (let wi = 0; wi < sentence.words.length; wi++) {
        const w = sentence.words[wi];
        if (w.type !== 'word') continue;
        total++;

        const modKey = `${si}_${wi}`;
        const mod = wordModifications[modKey];
        if (mod?.type === 'replaced') {
          known++;
        } else if (mod?.type === 'glossed') {
          known++;
          translated++;
        } else if (mod?.type === 'marked_cognate') {
          known++;
          cognates++;
          cognateSet.add((w.lemma || w.text).toLowerCase());
        } else if (w.status === 'cognate') {
          known++;
          cognates++;
          cognateSet.add((w.lemma || w.text).toLowerCase());
        } else if (mod?.type === 'marked_known') {
          known++;
        } else if (w.status === 'known') {
          known++;
        } else {
          // unknown
          unknownSet.add((w.lemma || w.text).toLowerCase());
        }
      }
    }
  }

  const percent = total > 0 ? Math.round((known / total) * 100) : 100;
  return {
    percent,
    knownWords: known - translated - cognates,
    totalWords: total,
    grammarIssues,
    translatedWords: translated,
    cognateWords: cognates,
    uniqueCognates: cognateSet.size,
    uniqueUnknown: unknownSet.size,
  };
}
