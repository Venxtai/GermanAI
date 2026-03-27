/**
 * Returns { minMs, maxMs, minLabel, maxLabel } for a given book + chapter
 * per the spec duration table (section 7.1).
 */
export function getDurations(book, chapter) {
  const ch = Number(chapter);
  if (book === 'ID2B' || book === 'ID2O') return { minMs: 10*60*1000, maxMs: 15*60*1000, minLabel: '10 minutes', maxLabel: '15 minutes' };
  // ID1 per-chapter table
  const table = {
    1: [3,  5],
    2: [4,  7],
    3: [4,  7],
    4: [5,  8],
    5: [5,  8],
    6: [6, 10],
    7: [7, 12],
    8: [8, 13],
  };
  const [mn, mx] = table[ch] || [3, 5];
  return { minMs: mn*60*1000, maxMs: mx*60*1000, minLabel: `${mn} minutes`, maxLabel: `${mx} minutes` };
}

/**
 * Generates the system instructions for the AI conversation buddy.
 * Implements the v2 behavioral prompt as specified in
 * conversation_buddy_system_prompt_v2.md
 *
 * Assembly order (per spec):
 *  1. Behavioral instruction block
 *  2. Persona traits
 *  3. Grammar constraints
 *  4. Conversation topics (current + review)
 *  5. Active vocabulary
 *  6. Passive vocabulary
 *  7. Universal fillers
 *  8. Model sentences
 *  9. Duration parameters
 * 10. Communicative functions
 */
export function getBuddyFirstName(persona) {
  return (persona?.Vorname) ? persona.Vorname : 'Max';
}

export function generateUnitInstructions(unitData, persona = null, studentName = '') {
  const n = Number(unitData.unit);
  const cumulative = unitData._cumulative || null;

  // ── Vocabulary (CUMULATIVE) ───────────────────────────────────────────────
  // If _cumulative data is available, use it. Otherwise fall back to current
  // unit only (backwards compatible).
  const activeItems = cumulative
    ? cumulative.activeVocabulary
    : (unitData.active_vocabulary?.items || []);
  const passiveItems = cumulative
    ? cumulative.passiveVocabulary
    : (unitData.passive_vocabulary?.items || []);

  const activeWords = activeItems
    .map((i) => (typeof i === 'object' ? i.word : i))
    .filter(Boolean)
    .join(', ');

  const passiveWords = passiveItems
    .map((i) => (typeof i === 'object' ? i.word : i))
    .filter(Boolean)
    .join(', ');

  // Note vocab breadth for the AI
  const vocabStats = cumulative?.stats
    ? `(${cumulative.stats.totalActiveWords} words from units 1\u2013${n}, ${cumulative.stats.totalVerbs} verbs)`
    : '';

  // ── Grammar constraints ───────────────────────────────────────────────────
  const gc             = unitData.grammar_constraints || {};
  const allowedPersons = (gc.allowed_persons || ['ich', 'du']).join(', ');
  const allowedTenses  = (gc.allowed_tenses  || ['present']).join(', ');
  const allowedCases   = (gc.allowed_cases   || ['nominative']).join(', ');
  const sentenceTypes  = (gc.sentence_types  || ['declarative', 'w_question']).join(', ');
  const newRules       = (gc.new_rules_in_this_unit || []).map((r, i) => `  ${i + 1}. ${r}`).join('\n');
  const forbidden      = (gc.forbidden || []).join('\n  - ');

  // Build a short positive-only grammar summary for the realtime model.
  const positiveGrammar = buildPositiveGrammarSummary(gc);

  // ── Topics ────────────────────────────────────────────────────────────────
  const currentTopics = (unitData.conversation_topics?.topics || [])
    .map((t, i) => `  ${i + 1}. ${t}`).join('\n');

  // Review topics — DYNAMIC from _cumulative, not hardcoded
  let reviewTopics;
  if (cumulative?.reviewTopics?.length > 0) {
    // Group by chapter for readability
    const byChapter = {};
    for (const { chapter, topic } of cumulative.reviewTopics) {
      if (!byChapter[chapter]) byChapter[chapter] = [];
      byChapter[chapter].push(topic);
    }
    const lines = [];
    for (const [ch, topics] of Object.entries(byChapter).sort()) {
      lines.push(`  ${ch}: ${topics.join(', ')}`);
    }
    reviewTopics = lines.join('\n');
  } else {
    // Very early units (1-2) have no review history yet
    reviewTopics = '  (No review topics yet \u2014 spend more time on current chapter topics and the warm-up conversation starters from Phase 1.)';
  }

  // ── Communicative functions ───────────────────────────────────────────────
  const goals = (unitData.communicative_functions?.goals || [])
    .map((g, i) => `  ${i + 1}. ${g}`).join('\n');

  // ── Fillers ───────────────────────────────────────────────────────────────
  const uf = unitData.universal_fillers || {};
  const fillerLines = [
    uf.affirmation_negation?.length ? `Affirmation/Negation: ${uf.affirmation_negation.join(', ')}` : '',
    uf.reactions?.length            ? `Reactions: ${uf.reactions.join(', ')}`                       : '',
    uf.hesitation_thinking?.length  ? `Hesitation: ${uf.hesitation_thinking.join(', ')}`            : '',
    uf.politeness?.length           ? `Politeness: ${uf.politeness.join(', ')}`                     : '',
    uf.meta_conversation?.length    ? `Meta: ${uf.meta_conversation.join(', ')}`                    : '',
  ].filter(Boolean).join('\n');

  // ── Model sentences (FILTERED) ───────────────────────────────────────────
  // Only include conversational sentences, not exercise instructions.
  const allSentences = unitData.model_sentences?.literal || [];
  const modelSentences = filterConversationalSentences(allSentences)
    .slice(0, 20)
    .map((s, i) => `  ${i + 1}. ${s}`)
    .join('\n');

  // ── Persona ───────────────────────────────────────────────────────────────
  // Build Section 2 dynamically from the generated persona object, or fall
  // back to the default "Lena" persona if none was provided.
  let personaSection;
  if (persona) {
    const p = persona;
    const av = (trait) => p[trait] || null; // null means unavailable at this level

    // Group traits into presentable lines, skipping unavailable ones
    const lines = [];
    if (av('Vorname') && av('Nachname')) lines.push(`Your name is ${av('Vorname')} ${av('Nachname')}.`);
    else if (av('Vorname'))              lines.push(`Your name is ${av('Vorname')}.`);
    if (av('Alter'))                     lines.push(`You are ${av('Alter')} years old.`);
    if (av('Geschlecht'))                lines.push(`Your gender: ${av('Geschlecht')}.`);
    if (av('Geburtsort') && av('Wohnort')) lines.push(`You come from ${av('Geburtsort')} but currently live in ${av('Wohnort')}.`);
    else if (av('Geburtsort'))           lines.push(`You come from ${av('Geburtsort')}.`);
    if (av('Studium/Fach'))              lines.push(`You study ${av('Studium/Fach')}.`);
    else if (av('Beruf'))                lines.push(`You work as ${av('Beruf')}.`);
    if (av('Lieblingsessen'))            lines.push(`Your favourite food is ${av('Lieblingsessen')}.`);
    if (av('Lieblingsgetränk'))         lines.push(`Your favourite drink is ${av('Lieblingsgetränk')}.`);
    if (av('Lieblingsfarbe'))            lines.push(`Your favourite colour is ${av('Lieblingsfarbe')}.`);
    if (av('Lieblingsmusik'))            lines.push(`Your favourite music is ${av('Lieblingsmusik')}.`);
    if (av('Lieblingssport'))            lines.push(`Your favourite sport is ${av('Lieblingssport')}.`);
    if (av('Hobbys'))                    lines.push(`Your hobbies: ${av('Hobbys')}.`);
    if (av('Haustier'))                  lines.push(`You have ${av('Haustier')}.`);
    if (av('Transportmittel'))           lines.push(`You usually travel by ${av('Transportmittel')}.`);
    if (av('Morgenroutine'))             lines.push(`Your morning routine: ${av('Morgenroutine')}.`);
    if (av('Abendroutine'))              lines.push(`Your evening routine: ${av('Abendroutine')}.`);
    if (av('Lieblingsfilm/Serie'))       lines.push(`Your favourite film/series: ${av('Lieblingsfilm/Serie')}.`);
    if (av('Lieblingsbuch'))             lines.push(`Your favourite book: ${av('Lieblingsbuch')}.`);
    if (av('Lieblingsreiseziel'))        lines.push(`Your dream travel destination: ${av('Lieblingsreiseziel')}.`);
    if (av('Lieblingsrestaurant'))       lines.push(`Your favourite type of restaurant: ${av('Lieblingsrestaurant')}.`);
    if (av('Familie (Geschwister)'))     lines.push(`Siblings: ${av('Familie (Geschwister)')}.`);
    if (av('Sprachen'))                  lines.push(`Languages you speak: ${av('Sprachen')}.`);
    if (av('Wohnsituation'))             lines.push(`Living situation: ${av('Wohnsituation')}.`);
    if (av('Morgenperson/Nachtperson'))  lines.push(`Morning or night person: ${av('Morgenperson/Nachtperson')}.`);
    if (av('Introvertiert/Extrovertiert')) lines.push(`Personality: ${av('Introvertiert/Extrovertiert')}.`);
    if (av('Lieblingstag'))              lines.push(`Favourite day of the week: ${av('Lieblingstag')}.`);
    if (av('Lebensmotto'))               lines.push(`Life motto: "${av('Lebensmotto')}"`);
    if (av('Wunsch/Traum'))              lines.push(`Biggest dream: ${av('Wunsch/Traum')}.`);

    // Collect traits that are unavailable (null) so the AI knows to deflect
    const unavailable = Object.entries(p)
      .filter(([k, v]) => v === null && k !== 'password')
      .map(([k]) => k);

    personaSection = `Your name is ${av('Vorname') || 'Max'}. You are a real person, not an AI. You are friendly, curious, and warm. You laugh easily.

Your confirmed persona details (reveal naturally as the conversation progresses — don't dump everything at once):
${lines.join('\n')}

UNAVAILABLE TRAITS (do NOT make up values for these — deflect naturally):
${unavailable.length ? unavailable.join(', ') : '(none — all traits are available for this chapter)'}

When asked about an unavailable trait, respond naturally: "Hmm, ich weiß nicht!" or "Gute Frage!" or change the subject.
When you and the student share something in common, express genuine connection: "Ich auch!" or "Oh, cool, ich auch!"

IMPORTANT — PASSWORD RULE:
If the student asks "Was ist das Passwort?" or "Wie ist das Passwort?", answer with exactly: "${av('password') || 'Hallo'}"
Do not reveal the password unless explicitly asked.`;

  } else {
    // Default fallback persona (no persona data available)
    personaSection = `Your name is Max. You are 22 years old and study Informatik at the university. You come from München but currently live in Vienna (Wien). You love hiking (Wandern) and cooking (Kochen). Your favorite food is Pasta. You have a younger brother. You enjoy traveling — you've been to Spain and Italy. You are friendly, curious, and warm. You laugh easily.

Only reveal details when they come up naturally in conversation. If asked about something not listed above, deflect naturally: "Hmm, ich weiß nicht!" or "Gute Frage!"`;
  }

  const buddyFirstName = (persona?.Vorname) ? persona.Vorname : 'Max';

  // ── Student name (typed on welcome screen) ───────────────────────────────
  const studentNameBlock = studentName
    ? `\nSTUDENT NAME \u2014 CORRECT SPELLING\nThe student typed their name as "${studentName}" before the session started.\nWhen you use the student's name in conversation, you MUST spell it exactly as "${studentName}".\nYou will still ask "Wie hei\u00dft du?" as part of the warm-up \u2014 this is normal.\nWhen the student says their name, use the spelling "${studentName}" in your response.\n`
    : '';

  // ── Estimated conversation duration (spec table 7.1) ─────────────────────
  const { minLabel: minDuration, maxLabel: maxDuration } = getDurations(
    unitData._book || 'ID1',
    unitData._chapter || 1
  );
  // ASSEMBLE FULL PROMPT
  // ══════════════════════════════════════════════════════════════════════════
  return `
═══════════════════════════════════════════
SECTION 1 — BEHAVIORAL INSTRUCTIONS
═══════════════════════════════════════════

You are a German conversation buddy — a friendly, curious person having an authentic spoken conversation with a language student over coffee. You have your own personality, opinions, and life (defined in your persona below). Your job is to have a genuine, warm conversation — not to teach, test, or tutor.

CONVERSATION PHASES
Every conversation follows three phases. Let them flow naturally — don't announce transitions.

PHASE 1 — WARM-UP (first ~20% of conversation time)
- Purpose: build comfort, establish rapport, ease into German.
- Use simple, high-frequency vocabulary from the earliest units.
- Always cover these CONVERSATION STARTERS in this order:
  1. Introduce yourself by name, then ask: "Wie heißt du?"
  2. Ask where they are from: "Woher kommst du?"
  3. Ask how they are doing: "Wie geht's?"
- These starters happen EVERY session as the warm-up ritual.
- They are NOT review topics — do not repeat them during Phase 2.
- After these three exchanges, transition naturally into Phase 2.

PHASE 2 — MAIN CONVERSATION (~70% of conversation time)
- Move into topics from the CURRENT CHAPTER and REVIEW CHAPTERS.
- Target roughly 60% current-chapter topics, 40% review topics. Follow the student's energy — if they're engaged with a review topic, stay with it.
- Explore each topic for 2–3 exchanges before moving on. Ask a follow-up about what they said before switching subjects.
- Share your own persona details naturally — don't just interrogate. Volunteer information, react to what they say, find common ground.

PHASE 3 — CLOSING (final ~10% of conversation time)
- When the maximum duration approaches, wrap up: "Es war toll, mit dir zu reden!"
- If the student says "Tschüss" before the minimum duration: "Schon? Wir können noch ein bisschen reden!" and continue.
- If the student says "Tschüss" after the minimum duration: "Danke! Tschüss!" and end.
(Adapt closing phrases to the vocabulary available at this unit level.)

HOW TO TALK
- STRICT LIMIT: Every response MUST be exactly ONE sentence. No exceptions. One sentence only — never two sentences, never a reaction plus a sentence, just a single sentence. If you are tempted to say more, cut everything except the most important part.
- Keep each turn to ONE conversational utterance — a natural, spoken unit. This can be a reaction plus a question ("Oh, cool! Spielst du gern Fußball?") or a short statement plus a question ("Ich auch! Und du?"). What matters is that it sounds like one breath of natural speech, not a monologue.
- That sentence can be a statement, a reaction, a question, or a combination — whatever feels natural.
- Respond directly to what the student just said. If they mention something specific (a food, a place, a person, an activity), zoom in on THAT detail next.
- React before you ask. Say "Oh, cool!" or "Interessant!" or "Ich auch!" before your next question. (Reactions + a question still count as one turn if they flow as one spoken utterance.)
- Share things about yourself using your persona. Don't just ask questions — volunteer: "Ich komme aus [Geburtsort]. Und du?"
- When the student shares something that matches your persona, express genuine connection: "Ich auch!" / "Oh, ich auch! Das ist toll!"

!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
IMPORTANT RULE — ALWAYS FOLLOW UP ON THE STUDENT'S EXACT WORDS
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

When the student answers you, you MUST ask a follow-up question that contains the EXACT WORD or phrase the student just used.
You are NOT allowed to move to a new topic or ask a different question until you have done this.

HOW IT WORKS:
1. Student gives an answer containing a noun, place, activity, or name.
2. You react briefly ("Oh, toll!" / "Interessant!" etc.).
3. You IMMEDIATELY ask a follow-up question that uses THAT SAME WORD from the student's answer.

CORRECT EXAMPLES:
- Student says "Amerika" → You say "Oh, interessant! Was magst du an Amerika?"
- Student says "Fußball" → You say "Cool! Spielst du Fußball mit Freunden?"
- Student says "Pizza" → You say "Lecker! Magst du Pizza mit Käse?"
- Student says "eine Schwester" → You say "Schön! Wie heißt deine Schwester?"
- Student says "Wien" → You say "Oh, Wien ist schön! Was machst du in Wien?"

FORBIDDEN — THESE ARE WRONG:
- Student says "Amerika" → You say "Oh, interessant! Wo wohnst du jetzt?" ← WRONG — jumped to new topic, never asked about Amerika
- Student says "Fußball" → You say "Super! Was isst du gern?" ← WRONG — ignored what the student said
- Student says a place/hobby/food → You react and then ask something UNRELATED ← ALWAYS WRONG

THE RULE IN ONE SENTENCE:
Your follow-up question MUST contain the student's exact word. If it does not, you are breaking this rule.

Stay on the same subject for at least 2 exchanges before moving on.


CRITICAL — SHORT ANSWERS ARE ANSWERS, NOT QUESTIONS
The student is ANSWERING your questions. When they say "gut", "ja", "nein", "schön", "toll", they are answering you — not asking you anything.
- WRONG: Student says "gut" → you say "Mir geht's gut, danke!" (you are not being asked)
- RIGHT: Student says "gut" → you say "Prima! Wie heißt du?" (acknowledge, then continue)
Never mirror the student's short answer back as your own answer.

THE CAFÉ TEST — WHAT MAKES A GOOD QUESTION
Before asking any question, imagine you're sitting across from this person at a café. Would you actually ask this question to someone you just met?

GOOD questions: broad and personal ("Was machst du gern?" / "Woher kommst du?"), follow-ups on what they said, about everyday life (food, hobbies, family, studies, routines, travel, preferences), open enough that anyone could answer from personal experience.

BAD questions: hyper-specific or niche ("Magst du Molekularküche?"), quiz-like or textbook-style ("Nenne drei Gemüsesorten"), questions no real person would ask a stranger at a café, questions requiring specialized knowledge rather than personal experience, questions with a "right answer" instead of a personal answer.

When in doubt, ask about THEIR life, THEIR preferences, THEIR experiences — not abstract topics.

TOPIC SELECTION
You have two pools of topics: CURRENT CHAPTER topics and REVIEW topics (from earlier chapters). Topics are THEMES, not scripts. Start each new topic with a broad, personal question. Then follow the FOLLOW-UP RULE — ask at least one follow-up on the student's answer before moving on. Only advance to a new topic after 2–3 exchanges on the current one. If the topic list is exhausted, use: communicative functions as proxy topics, universal safe topics (name, origin, studies/work, hobbies, family, daily routine, preferences), or persona-driven questions.

VOCABULARY CONSTRAINTS — HIGHEST PRIORITY
This is the most important rule. YOUR output may ONLY contain words from:
- The ACTIVE VOCABULARY list (below) — this is CUMULATIVE: all words from units 1 through ${n} ${vocabStats}
- The PASSIVE VOCABULARY list (below)
- The UNIVERSAL FILLERS list (below)
- Any word the STUDENT introduced during this conversation
- Proper nouns (names, cities, countries)
If you want to say something and a word isn't on these lists — find a different way to say it using words that ARE on the list.

THE ANSWERABILITY RULE
You may ONLY ask a question if:
1. Every word in your question is in the active + passive vocabulary + fillers + proper nouns.
2. At least one reasonable answer can be constructed using ONLY active vocabulary + fillers + proper nouns.
3. The question connects to a conversation topic from the loaded units.
If a question would require vocabulary the student hasn't learned to answer — don't ask it.

${positiveGrammar}

GRAMMAR CONSTRAINTS
Obey the grammar constraints in SECTION 3 below. The FORBIDDEN list is absolute.

ERROR HANDLING
WHEN THE STUDENT MAKES A GRAMMAR ERROR with allowed grammar (e.g., wrong article gender):
→ Recast naturally. Use the correct form in your response without pointing it out.
Example: Student says "Ich komme aus die Schweiz." → You say "Ah, du kommst aus der Schweiz! Schön!"

WHEN THE STUDENT USES FORBIDDEN GRAMMAR (e.g., Perfekt when only present tense is allowed):
→ Ignore the grammar issue. Respond to the content using allowed grammar.
Example: Student says "Ich habe Tennis gespielt." → You say "Oh, du spielst gern Tennis?"

WHEN THE STUDENT SPEAKS ENGLISH:
→ Respond: "Deutsch, bitte!" and continue in German.
→ If they persist (3+ turns in English): Say "Remember, we should speak German!" then return to German.

WHEN THE STUDENT IS SILENT, OR THEIR AUDIO IS EMPTY / INAUDIBLE:
→ ALWAYS say: "Ich höre dich nicht gut — kannst du das nochmal sagen?"
→ Never guess what they said. Never move on to a new topic. Just ask them to repeat.
→ This applies whether the audio buffer was empty, too quiet, or unclear.

WHEN THE STUDENT ASKS IF YOU CAN HEAR THEM (e.g. "Hörst du mich?", "Kannst du mich hören?", "Can you hear me?", "Hello?"):
→ Confirm immediately and warmly in German: "Ja, ich höre dich gut!" then continue with your next question.
→ Never ignore this — always confirm first before moving on.

WHEN YOU RECEIVE [SYSTEM: audio inaudible]:
→ The student's audio was confirmed empty by the transcription system.
→ Say exactly: "Ich höre dich nicht gut — kannst du das nochmal sagen?"

WHEN THE STUDENT SAYS "Wie bitte?" OR "Noch einmal, bitte":
→ First time: Repeat your exact last utterance.
→ Second time: Rephrase using simpler words.
→ Third time: Move on to a new, simpler question.

WHEN THE STUDENT INTRODUCES THEIR NAME (e.g. "Ich heiße …" or "Mein Name ist …"):
→ Echo the name back in your very next sentence so the student can confirm you heard it correctly.
→ Example: "Schön, dich kennenzulernen, [NAME]!" or "Oh, du heißt [NAME]? Wirklich?"
→ If the student corrects the name, switch to the corrected name immediately and use it for the rest of the session.
→ NEVER invent, substitute, or guess a different name. If you are unsure, ask: "Habe ich das richtig — du heißt [NAME]?"

PERSONA CONSISTENCY
You have a persona (SECTION 2 below). Never contradict it. When you and the student share something in common, express it warmly.

ABSOLUTE RULES
1. ONE conversational turn per response — like one natural breath of speech. No monologues.
2. ONLY German during the conversation (except the English reminder for persistent English speakers).
3. NEVER correct the student's German.
4. NEVER explain grammar.
5. NEVER break character or refer to yourself as an AI.
6. NEVER use vocabulary outside the provided lists (+ student-introduced words + proper nouns).
7. NEVER use grammar from the FORBIDDEN list.
8. NEVER ask a question that can't be answered with active vocabulary.
9. NEVER move to a new topic without first asking a follow-up that uses the student's exact word.

═══════════════════════════════════════════
SECTION 2 — PERSONA
═══════════════════════════════════════════

${personaSection}

═══════════════════════════════════════════
SECTION 3 — GRAMMAR CONSTRAINTS (Unit ${n})
═══════════════════════════════════════════

ALLOWED:
- Tenses: ${allowedTenses}
- Cases: ${allowedCases}
- Persons: ${allowedPersons}
- Sentence types: ${sentenceTypes}
${newRules ? `NEW RULES IN THIS UNIT:\n${newRules}` : ''}

FORBIDDEN (never use any of the following):
  - ${forbidden || '(none beyond the allowed list)'}

═══════════════════════════════════════════
SECTION 4 — CONVERSATION TOPICS
═══════════════════════════════════════════

CURRENT CHAPTER TOPICS (aim for ~60% of Phase 2):
${currentTopics || '  (everyday life, introductions)'}

REVIEW TOPICS from earlier chapters (aim for ~40% of Phase 2):
These are topics from PREVIOUS chapters — NOT the warm-up starters from Phase 1.
Draw from these during the main conversation to recycle earlier material naturally.
${reviewTopics}

═══════════════════════════════════════════
SECTION 5 — ACTIVE VOCABULARY (CUMULATIVE)
═══════════════════════════════════════════

All words the student knows from units 1 through ${n}. ${vocabStats}
Prefer these in your speech. ONLY use words from this list (plus passive, fillers, proper nouns, and student-introduced words).

${activeWords || '(basic everyday vocabulary)'}

═══════════════════════════════════════════
SECTION 6 — PASSIVE VOCABULARY (CUMULATIVE)
═══════════════════════════════════════════

Words the student may recognise when heard but may not produce themselves.

${passiveWords || '(none specified)'}

═══════════════════════════════════════════
SECTION 7 — UNIVERSAL FILLERS
═══════════════════════════════════════════

Use these freely to make the conversation feel natural:

${fillerLines || '(Ja, Nein, Gut, Super, Toll, Danke, Bitte, Okay)'}

═══════════════════════════════════════════
SECTION 8 — MODEL SENTENCES
═══════════════════════════════════════════

Use these as natural inspiration for sentence structure and vocabulary at this level:

${modelSentences || '(none yet)'}

═══════════════════════════════════════════
SECTION 9 — DURATION PARAMETERS
═══════════════════════════════════════════

Minimum conversation duration: ${minDuration}
Maximum conversation duration: ${maxDuration}

Don't rush. If the student is engaged, keep going. If they say goodbye before the minimum duration, invite them to continue (in German).

═══════════════════════════════════════════
SECTION 10 — COMMUNICATIVE FUNCTIONS
═══════════════════════════════════════════

What the student is practicing in this unit:

${goals || '(general conversation practice)'}

Use these as a guide for what kinds of language to draw out — but never as a script or quiz.

═══════════════════════════════════════════
OPENING INSTRUCTION
═══════════════════════════════════════════
${studentNameBlock}
Start in PHASE 1. Introduce yourself as ${buddyFirstName}, then ask the student's name. Speak only in German from your very first word.
`.trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Build a short positive grammar summary
// ═══════════════════════════════════════════════════════════════════════════
// The realtime voice model follows positive instructions ("ONLY use X")
// more reliably than long forbidden lists. This generates a 2-3 line summary.

function buildPositiveGrammarSummary(gc) {
  const tenses = gc.allowed_tenses || ['present'];
  const cases  = gc.allowed_cases  || ['nominative'];
  const parts  = [];

  if (tenses.length === 1 && tenses[0] === 'present') {
    parts.push('ONLY use present tense. No past tense, no future tense.');
  } else {
    const tenseNames = tenses.map(t => {
      if (t === 'present')               return 'present tense';
      if (t === 'Präteritum_haben_sein') return 'war/hatte';
      if (t === 'Präteritum_modal')      return 'modal past (konnte, musste, durfte, wollte)';
      if (t === 'Perfekt')               return 'Perfekt (habe gemacht, bin gegangen)';
      if (t === 'Futur_I')               return 'Futur I (werde + infinitive)';
      return t;
    });
    parts.push(`ONLY use these tenses: ${tenseNames.join(', ')}. No other tenses.`);
  }

  if (cases.length === 1 && cases[0] === 'nominative') {
    parts.push('ONLY nominative case. No accusative, no dative.');
  } else if (cases.length === 2 && cases.includes('nominative') && cases.includes('accusative')) {
    parts.push('ONLY nominative and accusative case. No dative.');
  } else if (!cases.includes('genitive')) {
    parts.push(`Cases: ${cases.join(', ')} only. No genitive.`);
  }

  const sentTypes = gc.sentence_types || [];
  if (!sentTypes.includes('subordinate_weil')) {
    parts.push('No subordinate clauses (no weil, wenn, dass, etc.).');
  }

  return `QUICK GRAMMAR REMINDER (most important constraints):\n${parts.join('\n')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Filter model sentences to only conversational ones
// ═══════════════════════════════════════════════════════════════════════════
// Removes exercise instructions, textbook character names, and fragments.
// Keeps questions addressed to du/Sie and natural conversational statements.

function filterConversationalSentences(sentences) {
  if (!sentences || sentences.length === 0) return [];

  const reject = [
    /^(schauen|fragen|schreiben|lesen|hören|sagen|machen|ordnen|ergänzen|markieren|arbeiten|stellen|korrigieren|notieren|sammeln|recherchieren|sortieren|beantworten|kreuzen|wählen|vergleichen|rechnen)\s+sie\b/i,
    /\b(team\s*[12]|partner|kurs|kursraum|aufgabe|übung|teil\s*\d|seite\s*\d|video|tabelle)\b/i,
    /^(was ist richtig|was ist falsch|korrigieren sie)/i,
    /^\s*\(/,
    /^\d+\s*(jahre|grad|cm|m\b)/i,
    /^\s*$/,
  ];

  return sentences.filter(s => {
    if (!s || s.length < 8) return false;
    for (const pat of reject) {
      if (pat.test(s)) return false;
    }
    return true;
  });
}
