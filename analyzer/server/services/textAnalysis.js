const Anthropic = require('@anthropic-ai/sdk');

let anthropic = null;
try {
  anthropic = new Anthropic();
} catch (e) {
  console.warn('[AI] Anthropic client not initialized — grammar analysis will be unavailable');
}

const AI_AVAILABLE = !!process.env.ANTHROPIC_API_KEY;

/**
 * Analyze a full text: tokenize, match vocabulary, detect grammar issues.
 *
 * @param {string} text - The input text to analyze
 * @param {Set<string>} selectedUnitIds - Set of selected unit IDs
 * @param {object} vocabData - { vocabIndex, verbFormIndex, universalFillers }
 * @param {object} unitMap - Full unit data map
 * @returns {object} Analysis result with sentences, words, grammar
 */
async function analyzeText(text, selectedUnitIds, vocabData, unitMap) {
  const { isWordKnown, findReplacements, getWordUnitInfo, formatFrequencyBand, normalizeWord } = require('./vocabIndex');

  // Split text into sentences
  const sentences = splitIntoSentences(text);

  // Build cumulative grammar constraints from selected units
  const cumulativeGrammar = buildCumulativeGrammar(selectedUnitIds, unitMap);

  // ── STEP 1: AI Lemmatization ──────────────────────────────────────────
  // Have AI extract the dictionary form (lemma) of every word in context.
  // This handles plurals (Achterbahnen→Achterbahn), conjugations (mag→mögen),
  // case declensions (Kindern→Kind), etc.
  const allSentenceTexts = sentences.map(s => s.text);
  const lemmaMap = await lemmatizeText(allSentenceTexts);

  // ── STEP 2: Batch grammar analysis via AI ─────────────────────────────
  const grammarResults = await analyzeGrammarBatch(allSentenceTexts, cumulativeGrammar);

  // ── STEP 3: Process each sentence with lemma-aware matching ───────────
  const analyzedSentences = [];

  for (let si = 0; si < sentences.length; si++) {
    const sentence = sentences[si];
    const words = tokenizeWords(sentence.text);
    const sentenceLemmas = lemmaMap[si] || {};

    const analyzedWords = [];
    for (const wordToken of words) {
      if (wordToken.type === 'punctuation' || wordToken.type === 'whitespace') {
        analyzedWords.push({ ...wordToken, status: 'neutral' });
        continue;
      }

      // Get the AI-determined lemma for this word (fall back to the word itself)
      const lemma = sentenceLemmas[wordToken.text.toLowerCase()] || wordToken.text;
      let isProperName = (sentenceLemmas._proper_names || []).includes(wordToken.text.toLowerCase());

      // Try matching with BOTH the surface form and the lemma
      let result = isWordKnown(
        wordToken.text,
        selectedUnitIds,
        vocabData.vocabIndex,
        vocabData.verbFormIndex,
        vocabData.universalFillers,
      );

      // If surface form not found, try the lemma
      if (!result.known && lemma.toLowerCase() !== normalizeWord(wordToken.text)) {
        const lemmaResult = isWordKnown(
          lemma,
          selectedUnitIds,
          vocabData.vocabIndex,
          vocabData.verbFormIndex,
          vocabData.universalFillers,
        );
        if (lemmaResult.known) {
          result = { ...lemmaResult, lemma };
        }
      }

      // Code-based fallback: try common German plural/declension patterns
      // This catches cases where the AI lemmatization failed (e.g., "Pilze" → "Pilze" instead of "Pilz")
      if (!result.known) {
        const w = normalizeWord(wordToken.text);
        const demorphGuesses = [];
        if (w.endsWith('e') && w.length > 3) demorphGuesses.push(w.slice(0, -1));           // Pilze → Pilz, Tage → Tag
        if (w.endsWith('en') && w.length > 4) demorphGuesses.push(w.slice(0, -2));          // Frauen → Frau, Katzen → Katz..
        if (w.endsWith('er') && w.length > 4) demorphGuesses.push(w.slice(0, -2));          // Kinder → Kind
        if (w.endsWith('n') && w.length > 3) demorphGuesses.push(w.slice(0, -1));           // Katzen → Katze
        if (w.endsWith('s') && w.length > 3) demorphGuesses.push(w.slice(0, -1));           // Autos → Auto
        if (w.endsWith('ern') && w.length > 5) demorphGuesses.push(w.slice(0, -3));         // Kindern → Kind
        // Umlaut reversal: ä→a, ö→o, ü→u
        if (w.includes('ä')) demorphGuesses.push(w.replace(/ä/g, 'a'));
        if (w.includes('ö')) demorphGuesses.push(w.replace(/ö/g, 'o'));
        if (w.includes('ü')) demorphGuesses.push(w.replace(/ü/g, 'u'));
        // Combined: umlaut + suffix
        for (const g of [...demorphGuesses]) {
          if (g.includes('ä')) demorphGuesses.push(g.replace(/ä/g, 'a'));
          if (g.includes('ö')) demorphGuesses.push(g.replace(/ö/g, 'o'));
          if (g.includes('ü')) demorphGuesses.push(g.replace(/ü/g, 'u'));
        }

        for (const guess of [...new Set(demorphGuesses)]) {
          if (guess === w || guess.length < 2) continue;
          const guessResult = isWordKnown(guess, selectedUnitIds, vocabData.vocabIndex, vocabData.verbFormIndex, vocabData.universalFillers);
          if (guessResult.known) {
            result = { ...guessResult, lemma: guess };
            break;
          }
        }
      }

      // Proper names: AI-detected OR code-based heuristic
      if (!result.known && isProperName) {
        result = { known: true, reason: 'proper_name' };
      }
      // Code-based proper name fallback:
      // A word is likely a proper name if:
      // 1. Capitalized and not the first word of the sentence
      // 2. Not found anywhere in the vocabulary index (any unit)
      // 3. The AI lemma does NOT start with an article (der/die/das = it's a noun, not a name)
      if (!result.known && wordToken.index > 0) {
        const firstChar = wordToken.text[0];
        if (firstChar && firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase()) {
          const norm = normalizeWord(wordToken.text);
          const allEntries = vocabData.vocabIndex.get(norm) || [];
          const allVerbs = vocabData.verbFormIndex.get(norm) || [];
          // Check if AI lemma suggests it's a noun (has article) vs proper name (no article)
          const lemmaLower = lemma.toLowerCase();
          const lemmaHasArticle = /^(der|die|das|ein|eine)\s/.test(lemmaLower);

          if (allEntries.length === 0 && allVerbs.length === 0 && !lemmaHasArticle) {
            // Not in vocab AND AI didn't add an article → proper name
            result = { known: true, reason: 'proper_name' };
            isProperName = true;
          }
        }
      }

      if (result.known) {
        analyzedWords.push({
          ...wordToken,
          status: 'known',
          reason: result.reason,
          entry: result.entry || null,
          verbForm: result.verbForm || null,
          lemma: result.lemma || lemma,
          isProperName,
        });
      } else {
        // Get info about where this word appears in the curriculum
        // Try both surface form and lemma
        let unitInfo = getWordUnitInfo(
          wordToken.text,
          Array.from(selectedUnitIds),
          Object.keys(unitMap),
          vocabData.vocabIndex,
        );
        if (!unitInfo.inCurriculum && lemma !== wordToken.text) {
          unitInfo = getWordUnitInfo(
            lemma,
            Array.from(selectedUnitIds),
            Object.keys(unitMap),
            vocabData.vocabIndex,
          );
        }

        // Find replacement suggestions (try lemma too)
        let replacements = findReplacements(
          wordToken.text,
          selectedUnitIds,
          vocabData.vocabIndex,
          vocabData.universalFillers,
        );
        if (replacements.length === 0 && lemma !== wordToken.text) {
          replacements = findReplacements(
            lemma,
            selectedUnitIds,
            vocabData.vocabIndex,
            vocabData.universalFillers,
          );
        }

        analyzedWords.push({
          ...wordToken,
          status: 'unknown',
          unitInfo,
          replacements,
          allEntries: result.entries || [],
          lemma,
        });
      }
    }

    // Grammar result for this sentence
    const grammar = grammarResults[si] || { status: 'ok', issues: [] };

    analyzedSentences.push({
      text: sentence.text,
      startOffset: sentence.startOffset,
      words: analyzedWords,
      grammar,
    });
  }

  // Detect linked word groups (separable verbs, compound tenses) via AI
  const linkedGroups = await detectLinkedGroups(sentences.map(s => s.text), selectedUnitIds, vocabData, unitMap);

  // Apply linked group info to words
  // IMPORTANT: group.wordIndices are word-only indices (0-based, skipping whitespace/punctuation)
  // but sentence.words includes whitespace/punctuation tokens.
  // We must map word-only index → array index using wordToken.index.
  for (const group of linkedGroups) {
    const sentence = analyzedSentences[group.sentenceIndex];
    if (!sentence) continue;

    for (const wordOnlyIdx of group.wordIndices) {
      // Find the word token whose .index matches the word-only index
      const word = sentence.words.find(w => w.type === 'word' && w.index === wordOnlyIdx);
      if (word) {
        word.linkedGroup = group.id;
        word.linkedLemma = group.lemma;
        word.linkedUnitId = group.unitId;
      }
    }
  }

  // Compute readability score
  const totalContentWords = analyzedSentences.flatMap(s => s.words).filter(w => w.type === 'word').length;
  const knownWords = analyzedSentences.flatMap(s => s.words).filter(w => w.type === 'word' && w.status === 'known').length;
  const grammarIssues = analyzedSentences.filter(s => s.grammar.status === 'issue').length;
  const readabilityPercent = totalContentWords > 0 ? Math.round((knownWords / totalContentWords) * 100) : 100;

  return {
    sentences: analyzedSentences,
    linkedGroups,
    readability: {
      percent: readabilityPercent,
      knownWords,
      totalWords: totalContentWords,
      grammarIssues,
    },
    cumulativeGrammar,
  };
}

/**
 * Use Claude Haiku to lemmatize all words in the text.
 * Returns an array (one per sentence) of objects mapping lowercase surface form → lemma.
 *
 * Example: "Ich mag Achterbahnen" → [{ "ich": "ich", "mag": "mögen", "achterbahnen": "Achterbahn" }]
 */
async function lemmatizeText(sentences) {
  if (sentences.length === 0) return [];

  if (!AI_AVAILABLE || !anthropic) {
    console.log('[LEMMA] No API key — skipping AI lemmatization (using surface forms only)');
    return sentences.map(() => ({}));
  }

  const prompt = `You are a German linguistic lemmatizer. For each sentence, extract the dictionary form (lemma) of every word AND identify proper names.

RULES:
- Nouns: give the nominative singular WITH article (e.g., "Achterbahnen" → "die Achterbahn", "Kindern" → "das Kind", "Häuser" → "das Haus")
- ALSO provide the noun without article as a second entry (e.g., "Achterbahnen" → "Achterbahn")
- Verbs: give the infinitive (e.g., "mag" → "mögen", "ging" → "gehen", "isst" → "essen", "heißt" → "heißen")
- Adjectives: give the base form (e.g., "großen" → "groß", "schönes" → "schön")
- Pronouns: give the nominative form (e.g., "mich" → "ich", "ihm" → "er")
- Possessives: give the base form (e.g., "meinen" → "mein", "unsere" → "unser")
- Contractions: expand them (e.g., "ins" → "in das", "beim" → "bei dem")
- Proper nouns (names of people, cities, countries, brands, etc.): keep as-is
- Numbers: keep as-is
- If the word is already in dictionary form, still include it

IMPORTANT: Also include a "_proper_names" key listing all proper nouns (lowercase) in the sentence.

SENTENCES:
${sentences.map((s, i) => `[${i}] ${s}`).join('\n')}

Respond with a JSON array (one object per sentence). Each object maps the lowercase surface form to its lemma string, plus a "_proper_names" array.
Example: [{"achterbahnen": "Achterbahn", "mag": "mögen", "niko": "Niko", "_proper_names": ["niko"]}]

ONLY output the JSON array, nothing else.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`[LEMMA] Lemmatized ${sentences.length} sentences, ${Object.keys(parsed.flat?.() || parsed[0] || {}).length}+ lemmas`);
      return parsed;
    }
    return sentences.map(() => ({}));
  } catch (err) {
    console.error('[LEMMA] Lemmatization error:', err.message);
    return sentences.map(() => ({}));
  }
}

/**
 * Split text into sentences.
 */
function splitIntoSentences(text) {
  const sentences = [];
  // Match sentences ending with . ! ? or end of text
  const regex = /[^.!?]*[.!?]+|[^.!?]+$/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const trimmed = match[0].trim();
    if (trimmed) {
      sentences.push({
        text: trimmed,
        startOffset: match.index,
      });
    }
  }
  if (sentences.length === 0 && text.trim()) {
    sentences.push({ text: text.trim(), startOffset: 0 });
  }
  return sentences;
}

/**
 * Tokenize a sentence into words and punctuation/whitespace.
 */
function tokenizeWords(sentence) {
  const tokens = [];
  // Match words (including hyphenated), punctuation, or whitespace
  const regex = /([a-zA-ZäöüÄÖÜßéèêàâîïôûç]+(?:-[a-zA-ZäöüÄÖÜßéèêàâîïôûç]+)*)|([.,!?;:"""„''()\[\]{}–—…\/])|(\s+)/g;
  let match;
  let idx = 0;
  while ((match = regex.exec(sentence)) !== null) {
    if (match[1]) {
      tokens.push({ type: 'word', text: match[1], index: idx, offset: match.index });
      idx++;
    } else if (match[2]) {
      tokens.push({ type: 'punctuation', text: match[2], offset: match.index });
    } else if (match[3]) {
      tokens.push({ type: 'whitespace', text: match[3], offset: match.index });
    }
  }
  return tokens;
}

/**
 * Build cumulative grammar constraints from selected units.
 * Returns the union of all allowed grammar features.
 */
function buildCumulativeGrammar(selectedUnitIds, unitMap) {
  const allowed = {
    tenses: new Set(),
    cases: new Set(),
    persons: new Set(),
    sentenceTypes: new Set(),
    forbidden: new Set(),
    newRules: [],
  };

  for (const uid of selectedUnitIds) {
    const unit = unitMap[uid];
    if (!unit?.grammar_constraints) continue;

    const gc = unit.grammar_constraints;
    for (const t of (gc.allowed_tenses || [])) allowed.tenses.add(t);
    for (const c of (gc.allowed_cases || [])) allowed.cases.add(c);
    for (const p of (gc.allowed_persons || [])) allowed.persons.add(p);
    for (const st of (gc.sentence_types || [])) allowed.sentenceTypes.add(st);
    for (const r of (gc.new_rules_in_this_unit || [])) allowed.newRules.push({ rule: r, unitId: uid });
  }

  // Forbidden = only things that are forbidden in ALL selected units
  // (if a later unit allows something, it's no longer forbidden)
  // Actually: use the last selected unit's forbidden list minus everything explicitly allowed
  const allForbidden = new Set();
  for (const uid of selectedUnitIds) {
    const gc = unitMap[uid]?.grammar_constraints;
    if (gc?.forbidden) {
      for (const f of gc.forbidden) allForbidden.add(f);
    }
  }
  // Remove anything that's explicitly allowed
  for (const t of allowed.tenses) allForbidden.delete(`tense:${t}`);
  for (const c of allowed.cases) allForbidden.delete(`case:${c}`);
  for (const p of allowed.persons) allForbidden.delete(`person:${p}`);
  for (const st of allowed.sentenceTypes) allForbidden.delete(`sentence_type:${st}`);
  // Also remove compound person entries (e.g., "person:er/es/sie/xier") if ANY sub-person is allowed
  for (const f of [...allForbidden]) {
    if (f.startsWith('person:')) {
      const personPart = f.slice('person:'.length);
      const subPersons = personPart.split('/');
      if (subPersons.some(sp => allowed.persons.has(sp) || allowed.persons.has(sp.trim()))) {
        allForbidden.delete(f);
      }
    }
  }

  return {
    allowedTenses: Array.from(allowed.tenses),
    allowedCases: Array.from(allowed.cases),
    allowedPersons: Array.from(allowed.persons),
    allowedSentenceTypes: Array.from(allowed.sentenceTypes),
    forbidden: Array.from(allForbidden),
    newRules: allowed.newRules,
  };
}

/**
 * Use Claude Haiku to analyze grammar for a batch of sentences.
 */
async function analyzeGrammarBatch(sentences, cumulativeGrammar) {
  if (sentences.length === 0) return [];

  // Skip AI analysis if no API key
  if (!AI_AVAILABLE || !anthropic) {
    console.log('[GRAMMAR] No API key — skipping AI grammar analysis');
    return sentences.map(() => ({ status: 'ok', structures: [], issues: [], note: 'Grammar analysis requires ANTHROPIC_API_KEY' }));
  }

  const prompt = `You are a German language grammar analyzer for a curriculum-aware text analysis tool.

Analyze each sentence and identify grammar structures used (tenses, cases, clause types).
Then check if any structures violate the allowed grammar constraints below.

ALLOWED GRAMMAR:
- Tenses: ${cumulativeGrammar.allowedTenses.join(', ') || 'none specified'}
- Cases: ${cumulativeGrammar.allowedCases.join(', ') || 'none specified'}
- Persons: ${cumulativeGrammar.allowedPersons.join(', ') || 'none specified'}
- Sentence types: ${cumulativeGrammar.allowedSentenceTypes.join(', ') || 'none specified'}

FORBIDDEN structures: ${cumulativeGrammar.forbidden.join(', ') || 'none'}

IMPORTANT DISAMBIGUATION RULES:
- "da" at the start of a sentence usually means "there" (adverb), NOT "since/because" (conjunction). "Da ist..." = "There is..." = declarative, NOT subordinate_da.
- "da" is only a subordinating conjunction when it connects TWO clauses: "Ich bleibe, da es regnet."
- Similarly, "wenn" at the start of a standalone sentence might be part of a conditional, but "wenn" within a multi-clause sentence is subordinate_wenn.
- Only flag a structure as forbidden if you are CERTAIN it applies. When in doubt, mark as "ok".

PRONOUN CASE DECLENSION RULE:
- If a person (e.g., "er") is in the allowed persons list, then ALL case-declined forms of that person are also allowed.
- For example, if "er" is allowed and Akkusativ is an allowed case, then "ihn" is allowed. If Dativ is allowed, "ihm" is allowed.
- Full declension: ich→mich/mir, du→dich/dir, er→ihn/ihm, sie→sie/ihr, es→es/ihm, wir→uns, ihr→euch, sie(pl)→sie/ihnen, Sie→Sie/Ihnen.
- NEVER flag a pronoun as a grammar violation just because it appears in a non-nominative form. Check if its nominative base form is in the allowed persons AND the case it appears in is allowed.

For each sentence, respond with a JSON object:
{
  "status": "ok" or "issue",
  "structures": [{"type": "tense|case|sentence_type", "value": "...", "allowed": true/false}],
  "issues": [{"description": "what the issue is", "suggestion": "how to fix it", "rewriteOptions": [{"label": "description", "targetStructure": "what to change to"}]}]
}

SENTENCES TO ANALYZE:
${sentences.map((s, i) => `[${i}] ${s}`).join('\n')}

Respond with a JSON array of objects, one per sentence. Only JSON, no other text.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '[]';
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return sentences.map(() => ({ status: 'ok', structures: [], issues: [] }));
  } catch (err) {
    console.error('[GRAMMAR] Analysis error:', err.message);
    return sentences.map(() => ({ status: 'ok', structures: [], issues: [], error: 'Analysis unavailable' }));
  }
}

/**
 * Use Claude Haiku to detect linked word groups (separable verbs, compound tenses).
 */
async function detectLinkedGroups(sentences, selectedUnitIds, vocabData, unitMap) {
  if (sentences.length === 0) return [];

  if (!AI_AVAILABLE || !anthropic) {
    console.log('[LINKED] No API key — skipping linked group detection');
    return [];
  }

  const prompt = `You are a German linguistics parser. For each sentence, identify linked word groups:

1. **Separable verbs**: e.g., "Ich kaufe im Supermarkt ein" → "kaufe" and "ein" are linked (einkaufen)
2. **Compound tenses (Perfekt/Plusquamperfekt)**: e.g., "Ich bin ins Kino gegangen" → "bin" and "gegangen" are linked (gehen, Perfekt)
3. **Modal + infinitive**: e.g., "Ich kann schwimmen" → "kann" and "schwimmen" are linked
4. **Future tense**: e.g., "Ich werde gehen" → "werde" and "gehen" are linked

For each group, provide:
- sentenceIndex: which sentence (0-based)
- wordIndices: array of word indices (0-based, counting only actual words not punctuation/whitespace)
- lemma: the dictionary form of the verb
- type: "separable_verb", "compound_tense", "modal_infinitive", "future"

SENTENCES:
${sentences.map((s, i) => `[${i}] ${s}`).join('\n')}

Respond with a JSON array of group objects. If no linked groups found, return []. Only JSON, no other text.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const groups = JSON.parse(jsonMatch[0]);
      // Assign IDs and look up in vocab index
      return groups.map((g, i) => {
        const lemmaLower = (g.lemma || '').toLowerCase();
        const entries = vocabData.vocabIndex.get(lemmaLower) || [];
        const activeEntry = entries.find(e => e.isActive && selectedUnitIds.has(e.unitId));

        return {
          id: `group_${i}`,
          sentenceIndex: g.sentenceIndex,
          wordIndices: g.wordIndices || [],
          lemma: g.lemma,
          type: g.type,
          unitId: activeEntry?.unitId || null,
          known: !!activeEntry,
        };
      });
    }
    return [];
  } catch (err) {
    console.error('[LINKED] Detection error:', err.message);
    return [];
  }
}

/**
 * Rewrite a sentence to fix a grammar issue.
 *
 * @param {string} sentence - Original sentence
 * @param {string} targetStructure - What to change to (e.g., "Perfekt", "Präsens")
 * @param {string} issueDescription - What the issue was
 * @param {Set<string>} selectedUnitIds - Selected units
 * @param {object} vocabData - Vocabulary data
 * @returns {object} { rewrittenSentence, wordMapping }
 */
async function rewriteSentence(sentence, targetStructure, issueDescription, selectedUnitIds, vocabData, priorReplacements) {
  if (!AI_AVAILABLE || !anthropic) {
    return { rewritten: sentence, changes: [], error: 'Rewrite requires ANTHROPIC_API_KEY' };
  }

  const replacementNote = priorReplacements?.length
    ? `\n\nPRIOR WORD REPLACEMENTS (MUST be preserved — do NOT revert these):\n${priorReplacements.map(r => `- "${r.original}" was replaced with "${r.replacement}"`).join('\n')}\nThese words have already been intentionally changed by the user. Your rewrite MUST keep these replacements intact.`
    : '';

  const prompt = `You are a German language expert. Rewrite this sentence to fix a grammar issue.

SENTENCE: "${sentence}"
ISSUE: ${issueDescription}
TARGET: Rewrite using ${targetStructure}
${replacementNote}

IMPORTANT RULES:
1. Keep the meaning as close as possible to the original
2. Only change what is necessary to fix the grammar issue
3. Keep all other words the same — especially any words that were previously replaced by the user

Respond with JSON:
{
  "rewritten": "the rewritten sentence",
  "changes": [{"original": "original word(s)", "replacement": "new word(s)", "explanation": "why changed"}]
}

Only JSON, no other text.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { rewritten: sentence, changes: [], error: 'Could not parse response' };
  } catch (err) {
    console.error('[REWRITE] Error:', err.message);
    return { rewritten: sentence, changes: [], error: err.message };
  }
}

/**
 * Generate a contextual translation for an unknown word (for glossing).
 */
async function generateGloss(word, sentenceContext, existingTranslation) {
  if (existingTranslation) return existingTranslation;

  if (!AI_AVAILABLE || !anthropic) {
    return `[translation unavailable — set ANTHROPIC_API_KEY]`;
  }

  const prompt = `Translate this German word to English based on context.

Word: "${word}"
Context: "${sentenceContext}"

Respond with ONLY the English translation (1-3 words), nothing else.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });

    return (response.content[0]?.text || '').trim();
  } catch (err) {
    console.error('[GLOSS] Error:', err.message);
    return '';
  }
}

/**
 * Suggest alternative WORDS or SHORT PHRASES from known vocabulary
 * that could replace an unknown word in context.
 *
 * Returns dictionary-form alternatives (not full sentences).
 * E.g., for "mag" (mögen) → ["gern haben", "toll finden", "lieben"]
 * E.g., for "Fortbewegungsmittel" → ["das Auto", "der Zug", "der Bus"]
 */
async function suggestWordAlternatives(sentence, unknownWord, unknownLemma, knownWords) {
  if (!AI_AVAILABLE || !anthropic) {
    return [];
  }

  const prompt = `You are a German language expert helping teachers adapt texts for students with limited vocabulary.

SENTENCE: "${sentence}"
UNKNOWN WORD: "${unknownWord}" (dictionary form: ${unknownLemma || unknownWord})

KNOWN VOCABULARY (the ONLY words the students know):
${knownWords.slice(0, 500).join(', ')}

Task: Suggest 2-5 alternative words or short phrases that could REPLACE "${unknownLemma || unknownWord}" in this specific sentence while keeping the meaning as close as possible.

Think step by step:
1. What does "${unknownLemma || unknownWord}" mean in THIS specific sentence context? Consider what the subject is doing and with what object.
2. What are different ways to express that same idea in German?
3. Which of those ways ONLY use words from the known vocabulary list above?

CRITICAL RULES:
- EVERY single word in your suggestions MUST appear in the known vocabulary list, or be a basic grammar word (der/die/das, ein/eine, ich/du/er, in/auf/mit, und/oder/aber, nicht, gern, gut, sehr).
- Multi-word phrases are PREFERRED over single words when they better capture the meaning. E.g., "gut finden" is better than just "finden". "gern fahren" is better than just "fahren" when talking about enjoying an activity.
- Think about what verb or phrase naturally goes with the OTHER words in the sentence. E.g., with "Achterbahnen" you RIDE them (fahren), not play with them.
- Do NOT suggest words that only make sense in a completely different context.
- Give the dictionary/base form (infinitive for verbs, nominative singular with article for nouns).
- Each suggestion should actually work when inserted into the sentence (possibly with grammar adjustments).

Respond ONLY with a JSON array:
[
  {"alternative": "the word or short phrase", "explanation": "2-5 word English explanation of meaning"}
]

If nothing works, return [].`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return [];
  } catch (err) {
    console.error('[ALTERNATIVES] Error:', err.message);
    return [];
  }
}

/**
 * Apply a word replacement to a sentence and fix grammar.
 * E.g., "Ich benutze ein Fortbewegungsmittel" + replace "Fortbewegungsmittel" with "Zug"
 * → "Ich benutze einen Zug" (article adjusted for masculine noun)
 */
async function applyReplacementWithGrammar(sentence, originalWord, replacement) {
  if (!AI_AVAILABLE || !anthropic) {
    // Simple fallback: just swap the word
    return { result: sentence.replace(new RegExp(originalWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), replacement) };
  }

  const prompt = `You are a German grammar expert. Replace a word in a sentence and fix any grammar issues.

ORIGINAL SENTENCE: "${sentence}"
REPLACE: "${originalWord}"
WITH: "${replacement}" (this is the dictionary/base form — you MUST conjugate/decline it properly)

CRITICAL Rules:
1. Replace "${originalWord}" with the PROPERLY CONJUGATED/DECLINED form of "${replacement}".
   - If it's a verb: conjugate for the correct person/tense in the sentence (e.g., "finden" with subject "Ich" in present → "finde", NOT "finden")
   - If it's a noun: use correct article and case
   - If it's an adjective: decline for gender/case/number
2. ARTICLE MATCHING: Look at whether "${originalWord}" had an article in front of it in the original sentence.
   - If the original word had NO article (e.g., "Ich esse gern Blumenkohl"), do NOT add an article to the replacement (→ "Ich esse gern Gemüse", NOT "Ich esse gern das Gemüse")
   - If the original word HAD an article (e.g., "Ich esse den Blumenkohl"), adjust the article for the replacement noun's gender/case (→ "Ich esse das Gemüse")
3. Fix any other grammar that breaks: verb agreement, case changes, word order.
4. Keep everything else EXACTLY the same — do not change tense, do not change other words.
5. The result must be grammatically correct German.

Respond with JSON:
{"result": "the corrected sentence"}

Only JSON, no other text.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { result: sentence.replace(originalWord, replacement) };
  } catch (err) {
    console.error('[GRAMMAR-FIX] Error:', err.message);
    return { result: sentence.replace(originalWord, replacement) };
  }
}

module.exports = {
  analyzeText,
  rewriteSentence,
  generateGloss,
  suggestWordAlternatives,
  applyReplacementWithGrammar,
  splitIntoSentences,
  tokenizeWords,
  buildCumulativeGrammar,
};
