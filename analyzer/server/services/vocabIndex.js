const fs = require('fs');
const path = require('path');

// Chapter metadata for all three books
const ID1_CHAPTERS = [
  { chapter: 1, title: 'Wer bin ich?: Heute und in der Zukunft', unitStart: 1, unitEnd: 15 },
  { chapter: 2, title: 'Was ziehe ich an?: Wetter und Klimawandel', unitStart: 16, unitEnd: 26 },
  { chapter: 3, title: 'Was ist da drin? Lebensmittel unter der Lupe', unitStart: 27, unitEnd: 37 },
  { chapter: 4, title: 'Wie gestalte ich mein Leben?: Schlanke Produktion f\u00fcr Haus und Alltag', unitStart: 38, unitEnd: 52 },
  { chapter: 5, title: 'Woher kommen meine Sachen?: Konsum, Verpackungen, M\u00fclltrennung', unitStart: 53, unitEnd: 67 },
  { chapter: 6, title: 'Wie war es damals?: Kindheit im Wandel der Zeit', unitStart: 68, unitEnd: 79 },
  { chapter: 7, title: "Was gibt's da zu sehen?: Sehensw\u00fcrdigkeiten in Wien", unitStart: 80, unitEnd: 93 },
  { chapter: 8, title: 'Wie sieht die Zukunft aus?: Erfindungen und Innovationen', unitStart: 94, unitEnd: 104 },
];

const ID2B_CHAPTERS = [
  { chapter: 1, title: 'Wie leben wir nachhaltig?: Kommunikation f\u00fcr die Zukunft unseres Planeten', unitStart: 1, unitEnd: 14 },
  { chapter: 2, title: 'Was war da los?: Ost-West-Geschichte(n)', unitStart: 15, unitEnd: 26 },
  { chapter: 3, title: 'Wer sind wir?: Deutsch im Plural', unitStart: 27, unitEnd: 37 },
  { chapter: 4, title: 'Wie unterhalten wir uns?: Alte und neue Medien', unitStart: 38, unitEnd: 52 },
];

const ID2O_CHAPTERS = [
  { chapter: 1, title: 'Wer w\u00fcrde sich trauen?: Achterbahnen und anderer Nervenkitzel', unitStart: 1, unitEnd: 17 },
  { chapter: 2, title: 'Wof\u00fcr/wogegen sind wir?: Protest, Widerstand, Mitbestimmung', unitStart: 18, unitEnd: 29 },
  { chapter: 3, title: 'Wie wird das gemacht?: Die Schweiz als Herstellerin von Qualit\u00e4tsprodukten', unitStart: 30, unitEnd: 41 },
  { chapter: 4, title: 'Was pr\u00e4gt uns?: Transatlantische Beziehungen und Einfl\u00fcsse', unitStart: 42, unitEnd: 52 },
];

const ALL_CHAPTERS = { ID1: ID1_CHAPTERS, ID2B: ID2B_CHAPTERS, ID2O: ID2O_CHAPTERS };

/**
 * Load all unit JSON files from the Knowledge Base directory.
 * Returns a Map: unitId (string) -> unit data object.
 */
function loadUnits() {
  const unitMap = {};
  const kbDir = path.join(__dirname, '../../../curriculum/units/Knowledge Base');

  if (!fs.existsSync(kbDir)) {
    console.warn('Knowledge Base directory not found:', kbDir);
    return unitMap;
  }

  const files = fs.readdirSync(kbDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(kbDir, file), 'utf8'));
      if (data.unit !== undefined) {
        unitMap[String(data.unit)] = data;
      }
    } catch (e) {
      console.warn(`Skipping ${file}: ${e.message}`);
    }
  }

  console.log(`[VOCAB] Loaded ${Object.keys(unitMap).length} units from Knowledge Base`);
  return unitMap;
}

/**
 * Get the book and chapter info for a unit ID.
 */
function getUnitBookAndChapter(unitId) {
  if (unitId.startsWith('B')) {
    const pos = parseInt(unitId.slice(1));
    const ch = ID2B_CHAPTERS.find(c => pos >= c.unitStart && pos <= c.unitEnd);
    return ch ? { book: 'ID2B', bookTitle: 'Impuls Deutsch 2 BLAU', chapter: ch.chapter, chapterTitle: ch.title } : null;
  }
  if (unitId.startsWith('O')) {
    const pos = parseInt(unitId.slice(1));
    const ch = ID2O_CHAPTERS.find(c => pos >= c.unitStart && pos <= c.unitEnd);
    return ch ? { book: 'ID2O', bookTitle: 'Impuls Deutsch 2 ORANGE', chapter: ch.chapter, chapterTitle: ch.title } : null;
  }
  const n = parseInt(unitId);
  const ch = ID1_CHAPTERS.find(c => n >= c.unitStart && n <= c.unitEnd);
  return ch ? { book: 'ID1', bookTitle: 'Impuls Deutsch 1', chapter: ch.chapter, chapterTitle: ch.title } : null;
}

/**
 * Build a comprehensive vocabulary index from all units.
 *
 * Returns:
 *   vocabIndex: Map<normalizedWord, Array<{
 *     word, unitId, translation, pos, frequency, cefr, isActive,
 *     modelSentences: [{sentence, unitId}]
 *   }>>
 *
 *   verbFormIndex: Map<normalizedConjugatedForm, Array<{
 *     lemma, unitId, tense, person, form
 *   }>>
 *
 *   universalFillers: Set<normalizedWord>
 *
 *   fillerPhrases: Array<string> (multi-word fillers, original case)
 */
function buildVocabIndex(unitMap) {
  const vocabIndex = new Map();     // normalized word -> [{unitId, ...}]
  const verbFormIndex = new Map();  // normalized conjugated form -> [{lemma, unitId, tense, person, form}]
  const universalFillers = new Set();
  const fillerPhrases = [];

  // Index universal fillers (from unit 1, same for all units)
  const fillers = unitMap['1']?.universal_fillers || {};
  for (const category of Object.values(fillers)) {
    if (Array.isArray(category)) {
      for (const filler of category) {
        const words = filler.toLowerCase().replace(/[.,!?]/g, '').split(/\s+/);
        if (words.length === 1 && words[0].length > 0) {
          universalFillers.add(words[0]);
        } else if (words.length > 1) {
          fillerPhrases.push(filler);
          for (const w of words) {
            if (w.length > 0) universalFillers.add(w);
          }
        }
      }
    }
  }

  // Index all vocabulary across all units
  for (const [unitId, unit] of Object.entries(unitMap)) {
    // Active vocabulary
    for (const item of (unit.active_vocabulary?.items || [])) {
      addToVocabIndex(vocabIndex, item, unitId, true, unit);
    }

    // Passive vocabulary
    for (const item of (unit.passive_vocabulary?.items || [])) {
      addToVocabIndex(vocabIndex, item, unitId, false, unit);
    }

    // Index allowed verb forms (conjugated form -> lemma mapping)
    const verbs = unit.allowed_verb_forms?.verbs || {};
    for (const [lemma, tenses] of Object.entries(verbs)) {
      for (const [tense, persons] of Object.entries(tenses)) {
        for (const [person, form] of Object.entries(persons)) {
          // Split separable verbs: "kaufe ein" -> ["kaufe", "ein"]
          const formParts = form.toLowerCase().split(/\s+/);
          for (const part of formParts) {
            if (!verbFormIndex.has(part)) verbFormIndex.set(part, []);
            verbFormIndex.get(part).push({ lemma, unitId, tense, person, form, fullForm: form });
          }
          // Also index the full form as a phrase
          const fullNorm = form.toLowerCase();
          if (!verbFormIndex.has(fullNorm)) verbFormIndex.set(fullNorm, []);
          verbFormIndex.get(fullNorm).push({ lemma, unitId, tense, person, form, fullForm: form });
        }
      }
    }
  }

  console.log(`[VOCAB] Index built: ${vocabIndex.size} unique words, ${verbFormIndex.size} verb forms, ${universalFillers.size} fillers`);

  return { vocabIndex, verbFormIndex, universalFillers, fillerPhrases, ALL_CHAPTERS };
}

/**
 * Normalize a German word for index lookup.
 * Lowercases and strips common punctuation.
 */
function normalizeWord(word) {
  return word.toLowerCase().replace(/[.,!?;:"""„''()\[\]{}–—…\/]/g, '').trim();
}

/**
 * Add a vocabulary item to the index.
 */
function addToVocabIndex(index, item, unitId, isActive, unit) {
  if (!item.word) return;

  // Get model sentences containing this word
  const modelSentences = [];
  const wordLower = item.word.toLowerCase();
  for (const sent of (unit.model_sentences?.literal || [])) {
    if (sent.toLowerCase().includes(wordLower) || sent.toLowerCase().includes(normalizeWord(item.word))) {
      modelSentences.push({ sentence: sent, unitId });
    }
  }

  // The "word" may contain article: "die Frau", "der Mann"
  // Index both the full form and the base word
  const entry = {
    word: item.word,
    unitId,
    translation: item.translation || '',
    pos: item.pos || '',
    frequency: item.frequency || null,
    cefr: item.cefr || '',
    isActive,
    modelSentences,
  };

  // Index by normalized full word
  const norm = normalizeWord(item.word);
  if (!index.has(norm)) index.set(norm, []);
  index.get(norm).push(entry);

  // If it has an article, also index the noun alone
  const parts = item.word.split(/\s+/);
  if (parts.length === 2 && ['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer'].includes(parts[0].toLowerCase())) {
    const nounNorm = normalizeWord(parts[1]);
    if (!index.has(nounNorm)) index.set(nounNorm, []);
    index.get(nounNorm).push(entry);
  }

  // For verbs with particles, also index the infinitive stem
  // e.g., "einkaufen" -> also index "kaufen", "einkaufen"
  if (item.pos === 'VERB') {
    const verbNorm = normalizeWord(item.word);
    // Common separable prefixes
    const prefixes = ['ab', 'an', 'auf', 'aus', 'bei', 'ein', 'mit', 'nach', 'vor', 'zu', 'zurück', 'zusammen', 'her', 'hin', 'um', 'weg', 'fest', 'los', 'teil', 'statt', 'kennen', 'fern'];
    for (const prefix of prefixes) {
      if (verbNorm.startsWith(prefix) && verbNorm.length > prefix.length + 2) {
        const stem = verbNorm.slice(prefix.length);
        if (!index.has(stem)) index.set(stem, []);
        // Don't duplicate if already there
        if (!index.get(stem).some(e => e.unitId === unitId && e.word === item.word)) {
          index.get(stem).push({ ...entry, _separablePrefix: prefix });
        }
      }
    }
  }
}

/**
 * Look up a word in the vocabulary index.
 * Returns all entries matching this word across all units.
 */
function lookupWord(word, vocabIndex, verbFormIndex, universalFillers) {
  const norm = normalizeWord(word);
  if (!norm) return { entries: [], isUniversalFiller: false, verbForms: [] };

  return {
    entries: vocabIndex.get(norm) || [],
    isUniversalFiller: universalFillers.has(norm),
    verbForms: verbFormIndex.get(norm) || [],
  };
}

// Basic German function words that are implicitly known (articles, basic pronouns, etc.)
// These are fundamental grammar elements taught from the very first units.
const GRAMMAR_WORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des',  // definite articles
  'ein', 'eine', 'einen', 'einem', 'einer',    // indefinite articles
  'kein', 'keine', 'keinen', 'keinem', 'keiner', // negation articles
  'nicht', 'auch', 'sehr', 'so', 'aber', 'oder', 'denn', 'doch', // common particles
  'und', 'mit', 'von', 'zu', 'für', 'auf', 'an', 'in', 'bei', 'nach', // basic prepositions
  'es', 'er', 'sie', 'wir', 'ihr', 'ich', 'du', 'man', // pronouns
  'mich', 'dich', 'sich', 'uns', 'euch',       // accusative pronouns
  'mir', 'dir', 'ihm', 'ihr', 'ihnen', 'uns',  // dative pronouns
  'ist', 'bin', 'bist', 'sind', 'seid', 'war', 'hat', 'haben', 'wird', // core verb forms
  'hier', 'da', 'dort', 'jetzt', 'dann', 'noch', 'schon', 'immer', // basic adverbs
  'was', 'wer', 'wie', 'wo', 'wann', 'warum', 'woher', 'wohin', // question words
  'diese', 'dieser', 'dieses', 'diesen', 'diesem', // demonstratives
  'alle', 'viele', 'einige', 'andere',           // quantifiers
]);

// Common German contractions: contraction -> [component1, component2]
const CONTRACTIONS = {
  'ins': ['in', 'das'], 'im': ['in', 'dem'], 'ans': ['an', 'das'], 'am': ['an', 'dem'],
  'aufs': ['auf', 'das'], 'beim': ['bei', 'dem'], 'fürs': ['für', 'das'],
  'hinterm': ['hinter', 'dem'], 'hinters': ['hinter', 'das'],
  'übers': ['über', 'das'], 'überm': ['über', 'dem'],
  'ums': ['um', 'das'], 'unterm': ['unter', 'dem'], 'unters': ['unter', 'das'],
  'vom': ['von', 'dem'], 'vors': ['vor', 'das'], 'vorm': ['vor', 'dem'],
  'zum': ['zu', 'dem'], 'zur': ['zu', 'der'],
};

/**
 * Check if a word is "known" given a set of selected unit IDs.
 * Known = active vocabulary in one of the selected units, OR universal filler.
 */
function isWordKnown(word, selectedUnitIds, vocabIndex, verbFormIndex, universalFillers) {
  const { entries, isUniversalFiller, verbForms } = lookupWord(word, vocabIndex, verbFormIndex, universalFillers);

  if (isUniversalFiller) return { known: true, reason: 'filler' };

  // Check basic grammar words (articles, pronouns, prepositions)
  const norm = normalizeWord(word);
  if (GRAMMAR_WORDS.has(norm)) return { known: true, reason: 'grammar_word' };

  // Check German contractions (e.g., "ins" = "in" + "das")
  if (CONTRACTIONS[norm]) {
    return { known: true, reason: 'contraction', components: CONTRACTIONS[norm] };
  }

  // Check active vocab in selected units
  for (const entry of entries) {
    if (entry.isActive && selectedUnitIds.has(entry.unitId)) {
      return { known: true, reason: 'active_vocab', entry };
    }
  }

  // Check verb forms in selected units
  for (const vf of verbForms) {
    if (selectedUnitIds.has(vf.unitId)) {
      // Find the vocab entry for this verb lemma
      const lemmaEntries = vocabIndex.get(normalizeWord(vf.lemma)) || [];
      const activeEntry = lemmaEntries.find(e => e.isActive && selectedUnitIds.has(e.unitId));
      if (activeEntry) {
        return { known: true, reason: 'verb_form', entry: activeEntry, verbForm: vf };
      }
    }
  }

  return { known: false, entries, verbForms };
}

/**
 * Find replacement suggestions: known words with similar translations.
 */
function findReplacements(unknownWord, selectedUnitIds, vocabIndex, universalFillers) {
  const norm = normalizeWord(unknownWord);
  const unknownEntries = vocabIndex.get(norm) || [];
  if (unknownEntries.length === 0) return [];

  // Get translations of the unknown word
  const translations = new Set();
  for (const entry of unknownEntries) {
    if (entry.translation) {
      for (const t of entry.translation.split(/[;,]/).map(s => s.trim().toLowerCase())) {
        if (t) translations.add(t);
      }
    }
  }

  if (translations.size === 0) return [];

  // Search for known words with overlapping translations
  const suggestions = [];
  for (const [word, entries] of vocabIndex) {
    if (word === norm) continue;
    for (const entry of entries) {
      if (!entry.isActive || !selectedUnitIds.has(entry.unitId)) continue;
      if (!entry.translation) continue;

      const entryTranslations = entry.translation.split(/[;,]/).map(s => s.trim().toLowerCase());
      const overlap = entryTranslations.some(t => translations.has(t));
      if (overlap) {
        suggestions.push({
          word: entry.word,
          unitId: entry.unitId,
          translation: entry.translation,
          pos: entry.pos,
        });
      }
    }
  }

  // Deduplicate by word
  const seen = new Set();
  return suggestions.filter(s => {
    const key = normalizeWord(s.word);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

/**
 * Format frequency band for display.
 */
function formatFrequencyBand(frequency) {
  if (!frequency) return null;
  const f = parseInt(frequency);
  if (isNaN(f)) return null;

  if (f <= 100) return 'among the Top 100 most-frequently used German words';
  if (f <= 200) return 'among the Top 200 most-frequently used German words';
  if (f <= 300) return 'among the Top 300 most-frequently used German words';
  if (f <= 400) return 'among the Top 400 most-frequently used German words';
  if (f <= 500) return 'among the Top 500 most-frequently used German words';
  if (f <= 600) return 'among the Top 600 most-frequently used German words';
  if (f <= 700) return 'among the Top 700 most-frequently used German words';
  if (f <= 800) return 'among the Top 800 most-frequently used German words';
  if (f <= 900) return 'among the Top 900 most-frequently used German words';
  if (f <= 1000) return 'among the Top 1,000 most-frequently used German words';
  if (f <= 1500) return 'among the Top 1,500 most-frequently used German words';
  if (f <= 2000) return 'among the Top 2,000 most-frequently used German words';
  if (f <= 2500) return 'among the Top 2,500 most-frequently used German words';
  if (f <= 3000) return 'among the Top 3,000 most-frequently used German words';
  if (f <= 3500) return 'among the Top 3,500 most-frequently used German words';
  if (f <= 4000) return 'among the Top 4,000 most-frequently used German words';
  if (f <= 4500) return 'among the Top 4,500 most-frequently used German words';
  if (f <= 5000) return 'among the Top 5,000 most-frequently used German words';
  return 'not among the Top 5,000 most-frequently used German words';
}

/**
 * Get info about which unit a word appears in (for red word feedback).
 */
function getWordUnitInfo(word, selectedUnitIds, allUnitIds, vocabIndex) {
  const norm = normalizeWord(word);
  const entries = vocabIndex.get(norm) || [];

  // Find all units where this word appears as active vocab
  const activeUnits = entries.filter(e => e.isActive).map(e => e.unitId);

  if (activeUnits.length === 0) {
    return { inCurriculum: false };
  }

  // Determine the relationship to selected units for each occurrence
  const selectedSet = new Set(selectedUnitIds);
  const maxSelected = getMaxUnitPosition(selectedUnitIds);

  // Return ALL units where the word appears, with status for each
  const allOccurrences = activeUnits.map(uid => {
    const pos = getUnitPosition(uid);
    let status;
    if (selectedSet.has(uid)) {
      status = 'selected'; // shouldn't happen for unknown words, but just in case
    } else if (pos !== null && pos <= maxSelected) {
      status = 'skipped';
    } else {
      status = 'not_reached';
    }
    return { unitId: uid, status };
  });

  // Return the first non-selected one as the primary
  const primary = allOccurrences.find(o => o.status !== 'selected') || allOccurrences[0];

  return {
    inCurriculum: true,
    unitId: primary.unitId,
    status: primary.status,
    allOccurrences,
  };
}

/**
 * Get the linear position of a unit for comparison purposes.
 */
function getUnitPosition(unitId) {
  if (unitId.startsWith('B')) return 104 + parseInt(unitId.slice(1));
  if (unitId.startsWith('O')) return 104 + 52 + parseInt(unitId.slice(1));
  return parseInt(unitId) || null;
}

function getMaxUnitPosition(unitIds) {
  let max = 0;
  for (const uid of unitIds) {
    const pos = getUnitPosition(uid);
    if (pos && pos > max) max = pos;
  }
  return max;
}

module.exports = {
  loadUnits,
  buildVocabIndex,
  normalizeWord,
  lookupWord,
  isWordKnown,
  findReplacements,
  formatFrequencyBand,
  getWordUnitInfo,
  getUnitBookAndChapter,
  ALL_CHAPTERS,
  ID1_CHAPTERS,
  ID2B_CHAPTERS,
  ID2O_CHAPTERS,
};
