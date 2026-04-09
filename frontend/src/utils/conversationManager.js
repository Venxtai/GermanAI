/**
 * ConversationManager — 5-phase conversation state machine.
 *
 * Phase 1: Warm-up (fixed questions)
 * Phase 2: Current chapter topics (60% of post-warmup time)
 * Phase 3: Previous chapter review with combined grammar (30%)
 * Phase 4: Student questions to the buddy (10%, if Ch1 complete)
 * Phase 5: Closing (always, no time constraint)
 *
 * Rules:
 * - Max 5 turns per topic, once left cannot return
 * - Same communicative functions/rules can be triggered across multiple topics
 * - Phase 3 uses Phase 2 + Phase 3 grammar combined on Phase 3 topics
 *
 * FILE: frontend/src/utils/conversationManager.js
 */

// Example transition bridges: topic pairs that connect naturally
const TOPIC_BRIDGES = {
  'Kleidung→das Wetter': 'ask if it\'s warm/cold and connect to what they wear',
  'Kleidung→der eigene Tagesablauf': 'ask what they wear at different times of day',
  'das Wetter→Kleidung': 'ask what they wear when the weather is like that',
  'das Wetter→Vorlieben und Abneigungen': 'ask if they like this weather',
  'Familie→Vorlieben und Abneigungen': 'ask what family members like to do',
  'Familie→Berufe': 'ask what family members do for work',
  'Familie→das eigene Umfeld': 'ask where family members live',
  'Berufe→Herkunft, Wohnort und Studium': 'ask about their studies or job',
  'der eigene Tagesablauf→Vorlieben und Abneigungen': 'ask what part of their day they like best',
  'Vorlieben und Abneigungen→Familie': 'ask if family members share the same preferences',
  'das eigene Umfeld→das Wetter': 'ask about the weather where they live',
  'Zahlen und Alter→Familie': 'ask how old family members are',
};

const MAX_TURNS_PER_TOPIC = 5;

// ── Debug logging helpers ──────────────────────────────────────────────
const PHASE_COLORS = {
  1: '#9CA3AF', // gray for warm-up
  2: '#3B82F6', // blue for current chapter
  3: '#F59E0B', // amber for review
  4: '#8B5CF6', // purple for student questions
  5: '#EF4444', // red for closing
};

function logPhaseHeader(phase, label, details = '') {
  const color = PHASE_COLORS[phase] || '#fff';
  console.log(
    `%c━━━ PHASE ${phase}: ${label} ━━━`,
    `color: ${color}; font-weight: bold; font-size: 13px;`
  );
  if (details) console.log(`%c${details}`, `color: ${color};`);
}

function logTopicList(label, topics, color = '#60A5FA') {
  if (!topics || topics.length === 0) return;
  console.log(`%c  ${label}:`, `color: ${color}; font-weight: bold;`);
  topics.forEach((t, i) => console.log(`%c    ${i + 1}. ${t}`, `color: ${color};`));
}

function logDirective(directive) {
  console.log(`%c  → DIRECTIVE: %c${directive.slice(0, 150)}${directive.length > 150 ? '…' : ''}`,
    'color: #F97316; font-weight: bold;', 'color: #FDBA74;');
}

function logTopicTracker(activeTopic, turns, completed, remaining) {
  console.log(
    `%c  📍 Active: %c"${activeTopic || 'none'}" %c(${turns} turn${turns !== 1 ? 's' : ''})` +
    `%c  | Completed: ${completed.size} | Remaining: ${remaining}`,
    'color: #A78BFA;', 'color: #C4B5FD; font-weight: bold;',
    'color: #A78BFA;', 'color: #7C3AED;'
  );
}
// ────────────────────────────────────────────────────────────────────────

export class ConversationManager {
  constructor({
    phase2 = { topics: [], communicativeFunctions: [], newRules: [], modelSentences: [] },
    phase3 = { topics: [], communicativeFunctions: [], newRules: [], modelSentences: [] },
    phase4Enabled = false,
    minMs,
    maxMs,
    chapterNumber = 1,
  }) {
    // Phase topic pools
    this.phase2Pool = phase2;
    this.phase3Pool = phase3;
    this.phase4Enabled = phase4Enabled;

    // Duration thresholds
    this.minMs = minMs;
    this.maxMs = maxMs;
    this.chapterNumber = chapterNumber;

    // Phase state: 1=warm-up, 2=current chapter, 3=review, 4=student questions, 5=closing
    this.phase = 1;
    this.startTime = null;
    this.phase1EndTime = null;    // Set when Phase 1 completes
    this.postWarmupBudget = 0;    // Remaining time after Phase 1
    this.phase2Deadline = 0;      // Absolute timestamp
    this.phase3Deadline = 0;
    this.phase4Deadline = 0;

    // Warm-up starters
    this.starters = this._initStarters();

    // Topic tracking (shared across all phases)
    this.activeTopic = null;
    this.activeTopicTurns = 0;
    this.topicTurnCounts = {};           // topic → total turn count
    this.completedTopics = new Set();    // Topics that have been left — CANNOT return
    this.aiTurnCount = 0;

    // Communicative functions + rules tracking
    // Each phase has its own functions/rules. We track which have been prompted.
    this.promptedFunctions = new Set();   // Functions we've already sent a directive for
    this.promptedRules = new Set();       // Rules we've already sent a directive for
    this.usedModelSentences = new Set();  // Model sentences already suggested
    this.functionPromptCooldown = 0;      // Turns to wait before next function prompt
    this.lastFunctionPromptTurn = 0;      // Turn number of last function prompt

    // Student utterance buffer (last 3 for bridge context)
    this.recentStudentUtterances = [];

    // Duration flags
    this.minReached = false;
    this.maxReached = false;

    // ── Log initial phase pools ──
    console.log('%c╔══════════════════════════════════════════════════════════════╗', 'color: #10B981; font-weight: bold;');
    console.log('%c║  CONVERSATION MANAGER — 5-Phase System Initialized         ║', 'color: #10B981; font-weight: bold;');
    console.log('%c╚══════════════════════════════════════════════════════════════╝', 'color: #10B981; font-weight: bold;');
    console.log(`%c  Chapter: ${chapterNumber} | Min: ${Math.round(minMs/60000)}m | Max: ${Math.round(maxMs/60000)}m | Phase 4: ${phase4Enabled ? 'ENABLED' : 'DISABLED'}`, 'color: #10B981;');

    logPhaseHeader(2, 'CURRENT CHAPTER — Available Topics', `Source units: ${phase2.sourceUnits?.join(', ') || '(none)'}`);
    logTopicList('Topics', phase2.topics, '#3B82F6');
    logTopicList('Communicative Functions', phase2.communicativeFunctions, '#60A5FA');
    logTopicList('Grammar Rules', phase2.newRules, '#93C5FD');

    logPhaseHeader(3, 'PREVIOUS CHAPTER REVIEW — Available Topics', `Source units: ${phase3.sourceUnits?.join(', ') || '(none)'}`);
    logTopicList('Topics', phase3.topics, '#F59E0B');
    logTopicList('Communicative Functions (combined)', phase3.communicativeFunctions, '#FBBF24');
    logTopicList('Grammar Rules (combined)', phase3.newRules, '#FCD34D');

    if (phase4Enabled) {
      logPhaseHeader(4, 'STUDENT QUESTIONS', 'Student asks buddy questions — enabled');
    } else {
      console.log('%c  Phase 4: SKIPPED (student hasn\'t completed enough curriculum)', 'color: #6B7280;');
    }
    console.log('%c──────────────────────────────────────────────────────────────', 'color: #374151;');

    // Phase transition flags
    this.phase2Signaled = false;
    this.phase3Signaled = false;
    this.phase4Signaled = false;
    this.phase5Signaled = false;
    this.phase4StudentAsked = false;     // Has student asked at least 1 question in Phase 4

    // Track last transition directive to avoid repeating
    this.lastSuggestedTopic = null;
  }

  _initStarters() {
    if (this.chapterNumber === 1) return { name: false };
    return { name: false, howAreYou: false, origin: false, currentPlace: false };
  }

  start() { this.startTime = Date.now(); }
  getElapsedMs() { return this.startTime ? Date.now() - this.startTime : 0; }
  isMinDurationReached() { return this.getElapsedMs() >= this.minMs; }
  getPhase() { return this.phase; }

  // Called from useVoiceConnection after each student transcript
  addStudentUtterance(text) {
    if (text && text !== '(inaudible)') {
      this.recentStudentUtterances.push(text);
      if (this.recentStudentUtterances.length > 3) {
        this.recentStudentUtterances.shift();
      }
    }
  }

  // ─── Compute time budgets after Phase 1 ends ─────────────────────
  _computeTimeBudgets() {
    this.phase1EndTime = Date.now();
    this.postWarmupBudget = Math.max(0, this.maxMs - (this.phase1EndTime - this.startTime));
    this.phase2Deadline = this.phase1EndTime + this.postWarmupBudget * 0.60;
    this.phase3Deadline = this.phase1EndTime + this.postWarmupBudget * 0.90; // 60% + 30%
    this.phase4Deadline = this.phase1EndTime + this.postWarmupBudget;        // 60% + 30% + 10%

    const warmupSec = Math.round((this.phase1EndTime - this.startTime) / 1000);
    const budgetSec = Math.round(this.postWarmupBudget / 1000);
    console.log(
      `%c  ⏱ Time budgets computed: Warm-up took ${warmupSec}s | Remaining: ${budgetSec}s` +
      `\n    Phase 2: ${Math.round(this.postWarmupBudget * 0.60 / 1000)}s (60%)` +
      `\n    Phase 3: ${Math.round(this.postWarmupBudget * 0.30 / 1000)}s (30%)` +
      `\n    Phase 4: ${Math.round(this.postWarmupBudget * 0.10 / 1000)}s (10%)`,
      'color: #06B6D4;'
    );
  }

  // ─── Get the next uncovered topic from a specific pool ────────────
  _getNextTopicFromPool(pool, excludeTopic = null) {
    for (const t of pool) {
      if (t !== excludeTopic && !this.completedTopics.has(t) &&
          (this.topicTurnCounts[t] || 0) < MAX_TURNS_PER_TOPIC) {
        return t;
      }
    }
    return null;
  }

  // ─── Get topics for the current phase ─────────────────────────────
  _getCurrentPhaseTopics() {
    if (this.phase === 2) return this.phase2Pool.topics;
    if (this.phase === 3) return this.phase3Pool.topics;
    return [];
  }

  // ─── Check if all topics in current phase are exhausted ───────────
  _isCurrentPhaseExhausted() {
    const topics = this._getCurrentPhaseTopics();
    return topics.every(t => this.completedTopics.has(t) || (this.topicTurnCounts[t] || 0) >= MAX_TURNS_PER_TOPIC);
  }

  // ─── Build a bridge hint between two topics ─────────────────────────
  _getBridgeHint(fromTopic, toTopic) {
    const key = `${fromTopic}→${toTopic}`;
    if (TOPIC_BRIDGES[key]) return TOPIC_BRIDGES[key];

    const recentWords = this.recentStudentUtterances.slice(-2).join(' ');
    if (recentWords) {
      return `The student recently said: "${recentWords}". Find a natural connection to "${toTopic}" from what they shared.`;
    }
    return `Find a natural way to transition to "${toTopic}".`;
  }

  // ─── Get unprompted communicative functions for the current phase ────
  _getUnpromptedFunctions() {
    const pool = this.phase === 2 ? this.phase2Pool : this.phase === 3 ? this.phase3Pool : null;
    if (!pool) return [];
    return (pool.communicativeFunctions || []).filter(f => !this.promptedFunctions.has(f));
  }

  _getUnpromptedRules() {
    const pool = this.phase === 2 ? this.phase2Pool : this.phase === 3 ? this.phase3Pool : null;
    if (!pool) return [];
    return (pool.newRules || []).filter(r => !this.promptedRules.has(r));
  }

  // ─── Get unused model sentence suggestions for the current topic ────
  _getModelSentenceSuggestions(topic, count = 2) {
    const pool = this.phase === 2 ? this.phase2Pool : this.phase === 3 ? this.phase3Pool : null;
    if (!pool?.modelSentences?.length) return '';
    // Filter to unused sentences, prefer ones matching the current topic
    const unused = (pool.modelSentences || []).filter(ms => !this.usedModelSentences.has(ms.sentence));
    if (unused.length === 0) return '';
    // Topic-matching first, then by score
    const topicMatch = unused.filter(ms => ms.topic && topic && ms.topic.toLowerCase().includes(topic.toLowerCase().split(' ')[0]));
    const picks = topicMatch.length > 0 ? topicMatch.slice(0, count) : unused.slice(0, count);
    picks.forEach(ms => this.usedModelSentences.add(ms.sentence));
    return picks.map(ms => `"${ms.sentence}"`).join(' or ');
  }

  // ─── Generate a function/rule prompt if the timing is right ─────────
  _checkFunctionPrompt() {
    if (this.phase !== 2 && this.phase !== 3) return [];
    // Wait at least 2 turns between function prompts
    if (this.aiTurnCount - this.lastFunctionPromptTurn < 2) return [];
    // Only prompt after we've settled into a topic (at least 1 turn on it)
    if (this.activeTopicTurns < 1) return [];

    const directives = [];
    const topic = this.activeTopic || 'the current topic';

    // Try unprompted functions first (higher priority)
    const unpromptedFns = this._getUnpromptedFunctions();
    if (unpromptedFns.length > 0) {
      const fn = unpromptedFns[0];
      this.promptedFunctions.add(fn);
      this.lastFunctionPromptTurn = this.aiTurnCount;
      const examples = this._getModelSentenceSuggestions(topic);
      const exampleHint = examples ? ` Example questions from the textbook: ${examples}.` : '';
      const d = `[SYSTEM: COMMUNICATIVE FUNCTION — The student should practice: "${fn}". ` +
        `Create an opportunity for the student to use this skill with the current topic "${topic}". ` +
        `Ask a question that naturally invites the student to demonstrate this function.${exampleHint} ` +
        `Adapt the question to what the student has been saying. Do NOT repeat a question you already asked. ` +
        `Do NOT explain what you're doing — just ask a natural question that requires this skill to answer.]`;
      directives.push(d);
      console.log(`%c  🎯 Function prompt: "${fn}" (with topic: "${topic}")`, 'color: #EC4899; font-weight: bold;');
      if (examples) console.log(`%c    📖 Model sentence examples: ${examples}`, 'color: #F9A8D4;');
      logDirective(d);
      return directives;
    }

    // Then try unprompted rules
    const unpromptedRules = this._getUnpromptedRules();
    if (unpromptedRules.length > 0) {
      const rule = unpromptedRules[0];
      this.promptedRules.add(rule);
      this.lastFunctionPromptTurn = this.aiTurnCount;
      const examples = this._getModelSentenceSuggestions(topic);
      const exampleHint = examples ? ` Example questions from the textbook: ${examples}.` : '';
      const d = `[SYSTEM: GRAMMAR PRACTICE — The student should practice this grammar rule: "${rule}". ` +
        `Ask a question about "${topic}" that would naturally elicit this grammar structure in the student's response.${exampleHint} ` +
        `Adapt to the conversation context. Do NOT repeat a question you already asked. ` +
        `Keep it conversational — do NOT quiz or teach.]`;
      directives.push(d);
      console.log(`%c  📐 Rule prompt: "${rule}" (with topic: "${topic}")`, 'color: #F472B6; font-weight: bold;');
      if (examples) console.log(`%c    📖 Model sentence examples: ${examples}`, 'color: #F9A8D4;');
      logDirective(d);
      return directives;
    }

    // Even without pending functions/rules, suggest a model sentence every ~3 turns for variety
    if (this.activeTopicTurns >= 2 && (this.aiTurnCount - this.lastFunctionPromptTurn) >= 3) {
      const examples = this._getModelSentenceSuggestions(topic, 1);
      if (examples) {
        this.lastFunctionPromptTurn = this.aiTurnCount;
        const d = `[SYSTEM: QUESTION VARIETY — Instead of repeating "würdest du lieber A oder B" patterns, ` +
          `try a different angle. Here's a question from the textbook you can adapt: ${examples}. ` +
          `Rephrase it naturally for the conversation. Do NOT repeat questions you already asked.]`;
        directives.push(d);
        console.log(`%c  📖 Variety prompt: ${examples}`, 'color: #A78BFA;');
        logDirective(d);
      }
    }

    return directives;
  }

  // ─── Called immediately after each AI turn ──────────────────────────
  processAITurn(aiText) {
    this.aiTurnCount++;
    const directives = [];
    const elapsed = this.getElapsedMs();
    const now = Date.now();

    // ── Phase 1: warm-up ──
    if (this.phase === 1) {
      this._detectStarters(aiText);

      if (this._allStartersDone()) {
        this.phase = 2;
        this.phase2Signaled = true;
        this._computeTimeBudgets();
        const firstTopic = this._getNextTopicFromPool(this.phase2Pool.topics);
        logPhaseHeader(2, 'CURRENT CHAPTER — Starting', `All warm-up starters done. First topic: "${firstTopic}"`);
        logTopicList('Topics', this.phase2Pool.topics, '#3B82F6');
        logTopicList('Communicative Functions', this.phase2Pool.communicativeFunctions, '#60A5FA');
        logTopicList('New Grammar Rules', this.phase2Pool.newRules, '#93C5FD');
        if (this.phase2Pool.modelSentences?.length) {
          const top = this.phase2Pool.modelSentences.slice(0, 10).map(ms => ms.sentence);
          logTopicList('Model Sentences (top 10)', top, '#818CF8');
        }
        directives.push(
          `[SYSTEM: Phase 1 complete — warm-up done. Move into Phase 2 (Current Chapter topics). ` +
          `Your first topic should be: "${firstTopic || 'the current unit topic'}". ` +
          `Use a natural topic transition. Do NOT repeat warm-up starters.]`
        );
      } else if (elapsed > this.maxMs * 0.25) {
        this.phase = 2;
        this.phase2Signaled = true;
        this._computeTimeBudgets();
        const missing = this._missingStarters();
        const firstTopic = this._getNextTopicFromPool(this.phase2Pool.topics);
        logPhaseHeader(2, 'CURRENT CHAPTER — Starting (time limit)', `Missing starters: ${missing.join(', ')}. First topic: "${firstTopic}"`);
        logTopicList('Topics', this.phase2Pool.topics, '#3B82F6');
        logTopicList('Communicative Functions', this.phase2Pool.communicativeFunctions, '#60A5FA');
        logTopicList('New Grammar Rules', this.phase2Pool.newRules, '#93C5FD');
        if (this.phase2Pool.modelSentences?.length) {
          const top = this.phase2Pool.modelSentences.slice(0, 10).map(ms => ms.sentence);
          logTopicList('Model Sentences (top 10)', top, '#818CF8');
        }
        directives.push(
          `[SYSTEM: Moving to Phase 2 (warm-up time limit). Missing: ${missing.join(', ')}. ` +
          `Start with topic: "${firstTopic || 'the current unit topic'}".]`
        );
      } else if (this.aiTurnCount === 2 && !this.starters.name) {
        directives.push('[SYSTEM: Ask "Wie heißt du?" now.]');
      }
    }

    // ── Phase 2 → 3 transition ──
    if (this.phase === 2 && !this.phase3Signaled) {
      const timeUp = this.phase2Deadline > 0 && now >= this.phase2Deadline;
      const exhausted = this._isCurrentPhaseExhausted();
      if (timeUp || exhausted) {
        const reason = exhausted ? 'all topics exhausted' : 'time budget reached';
        this.phase = 3;
        this.phase3Signaled = true;
        // Mark any active topic as completed before switching phases
        if (this.activeTopic) {
          this.completedTopics.add(this.activeTopic);
          this.activeTopic = null;
          this.activeTopicTurns = 0;
        }
        const firstReview = this._getNextTopicFromPool(this.phase3Pool.topics);
        if (firstReview) {
          logPhaseHeader(3, 'PREVIOUS CHAPTER REVIEW — Starting', `Reason: ${reason}. First review topic: "${firstReview}"`);
          logTopicList('Topics (previous chapter)', this.phase3Pool.topics, '#F59E0B');
          logTopicList('Communicative Functions (combined from both chapters)', this.phase3Pool.communicativeFunctions, '#FBBF24');
          logTopicList('Grammar Rules (combined from both chapters)', this.phase3Pool.newRules, '#FCD34D');
          if (this.phase3Pool.modelSentences?.length) {
            const top = this.phase3Pool.modelSentences.slice(0, 10).map(ms => ms.sentence);
            logTopicList('Model Sentences (top 10)', top, '#818CF8');
          }
          console.log(`%c  Completed from Phase 2: ${[...this.completedTopics].join(', ') || '(none)'}`, 'color: #6B7280;');
          // Log unprompted functions/rules carried over
          const unpromptedFns = this._getUnpromptedFunctions();
          const unpromptedRls = this._getUnpromptedRules();
          if (unpromptedFns.length > 0) console.log(`%c  ⚠ Unprompted functions from Phase 2: ${this.promptedFunctions.size} prompted, ${unpromptedFns.length} remaining`, 'color: #F59E0B;');
          if (unpromptedRls.length > 0) console.log(`%c  ⚠ Unprompted rules from Phase 2: ${this.promptedRules.size} prompted, ${unpromptedRls.length} remaining`, 'color: #F59E0B;');
          // Reset function tracking for Phase 3 (new pool of functions/rules)
          this.promptedFunctions.clear();
          this.promptedRules.clear();
          this.lastFunctionPromptTurn = this.aiTurnCount; // Small cooldown before prompting in new phase
          directives.push(
            `[SYSTEM: Phase 2 complete. Moving to Phase 3 — Previous Chapter Review. ` +
            `Switch to review topic: "${firstReview}". ` +
            `You can use ALL grammar and communicative functions from both this chapter and the previous chapter. ` +
            `Do NOT return to any Phase 2 topics.]`
          );
        } else {
          console.log(`%c  Phase 3 skipped — no review topics available`, 'color: #F59E0B;');
          // No review topics available — skip to Phase 4 or 5
          this._transitionPastPhase3(directives);
        }
      }
    }

    // ── Phase 3 → 4/5 transition ──
    if (this.phase === 3 && !this.phase4Signaled) {
      const timeUp = this.phase3Deadline > 0 && now >= this.phase3Deadline;
      const exhausted = this._isCurrentPhaseExhausted();
      if (timeUp || exhausted) {
        const reason = exhausted ? 'all review topics exhausted' : 'time budget reached';
        console.log(`%c  Phase 3 ending — reason: ${reason}`, 'color: #F59E0B;');
        console.log(`%c  All completed topics: ${[...this.completedTopics].join(', ')}`, 'color: #6B7280;');
        this._transitionPastPhase3(directives);
      }
    }

    // ── Phase 4 → 5 transition ──
    if (this.phase === 4 && !this.phase5Signaled) {
      const timeUp = this.phase4Deadline > 0 && now >= this.phase4Deadline;
      // Must guarantee at least 1 student question
      if (timeUp && this.phase4StudentAsked) {
        this.phase = 5;
        this.phase5Signaled = true;
        logPhaseHeader(5, 'CLOSING', 'Phase 4 complete — student asked at least 1 question');
        directives.push('[SYSTEM: Phase 4 complete. Move to Phase 5 — say your farewell now.]');
      }
    }

    // ── Min duration ──
    if (!this.minReached && elapsed >= this.minMs) {
      this.minReached = true;
      console.log(`%c  ⏱ Minimum duration reached (${Math.round(elapsed/1000)}s)`, 'color: #10B981;');
      directives.push('[SYSTEM: Minimum conversation time reached. If the student says goodbye, you may end warmly.]');
    }

    // ── Hard max (safety net — Phase 4 guarantees 1 question first) ──
    if (!this.maxReached && elapsed >= this.maxMs && this.phase < 4) {
      this.maxReached = true;
      this.phase = 5;
      this.phase5Signaled = true;
      logPhaseHeader(5, 'CLOSING — HARD MAX', `Maximum time reached (${Math.round(elapsed/1000)}s)`);
      directives.push('[SYSTEM: Maximum time reached. Say farewell NOW.]');
    }

    // Log all directives from this turn
    if (directives.length > 0) {
      directives.forEach(d => logDirective(d));
    }

    return directives;
  }

  _transitionPastPhase3(directives) {
    if (this.phase4Enabled && !this.phase4Signaled) {
      this.phase = 4;
      this.phase4Signaled = true;
      if (this.activeTopic) {
        this.completedTopics.add(this.activeTopic);
        this.activeTopic = null;
        this.activeTopicTurns = 0;
      }
      logPhaseHeader(4, 'STUDENT QUESTIONS — Starting', 'Student gets to ask the buddy questions');
      directives.push(
        `[SYSTEM: Phase 3 complete. Moving to Phase 4 — Student Questions. ` +
        `Ask the student: "Hast du Fragen an mich?" or a natural equivalent. ` +
        `Let them ask you questions about yourself, your life, etc. Answer using your persona. ` +
        `Stay in this mode until they have no more questions or time runs out.]`
      );
    } else {
      this.phase = 5;
      this.phase5Signaled = true;
      this.phase4Signaled = true; // skip
      logPhaseHeader(5, 'CLOSING', this.phase4Enabled ? 'Phase 4 skipped' : 'Phase 4 not enabled — going to closing');
      directives.push('[SYSTEM: Moving to Phase 5 — say your farewell now.]');
    }
  }

  // ─── Called when async topic classification returns ──────────────────
  updateTopicClassification({ matchedTopics = [] }) {
    const primaryTopic = matchedTopics[0] || null;
    const phaseLabel = this.phase === 2 ? 'Phase 2' : this.phase === 3 ? 'Phase 3' : `Phase ${this.phase}`;

    if (!primaryTopic) {
      console.log(`%c  🏷 [${phaseLabel}] Classification: no topic matched`, 'color: #6B7280;');
      return [];
    }
    if (this.phase !== 2 && this.phase !== 3) return [];

    // Update turn counts
    for (const t of matchedTopics) {
      this.topicTurnCounts[t] = (this.topicTurnCounts[t] || 0) + 1;
    }

    // Track active topic streak
    if (primaryTopic === this.activeTopic) {
      this.activeTopicTurns++;
      console.log(
        `%c  🏷 [${phaseLabel}] Topic: "${primaryTopic}" — turn ${this.activeTopicTurns}/${MAX_TURNS_PER_TOPIC}`,
        `color: ${this.activeTopicTurns >= MAX_TURNS_PER_TOPIC ? '#EF4444' : this.activeTopicTurns === MAX_TURNS_PER_TOPIC - 1 ? '#F59E0B' : '#10B981'};`
      );
    } else {
      // Switching away from a topic — mark old one as completed (cannot return)
      if (this.activeTopic) {
        this.completedTopics.add(this.activeTopic);
        console.log(`%c  ✅ Topic completed (left): "${this.activeTopic}"`, 'color: #6B7280; text-decoration: line-through;');
      }
      this.activeTopic = primaryTopic;
      this.activeTopicTurns = 1;
      this.lastSuggestedTopic = null;
      console.log(`%c  🏷 [${phaseLabel}] NEW topic: "${primaryTopic}" — turn 1/${MAX_TURNS_PER_TOPIC}`, 'color: #10B981; font-weight: bold;');
    }

    // Log remaining topics
    const remaining = this.getRemainingTopics();
    logTopicTracker(this.activeTopic, this.activeTopicTurns, this.completedTopics, remaining.length);
    if (remaining.length > 0) {
      console.log(`%c    Remaining: ${remaining.join(', ')}`, 'color: #7C3AED;');
    }

    const directives = [];
    const phaseTopics = this._getCurrentPhaseTopics();

    // ── TOPIC TRANSITION LOGIC ──
    // After 4 turns: gentle suggestion (one more then switch)
    // After 5 turns: firm directive (must switch now)
    if (this.activeTopicTurns >= MAX_TURNS_PER_TOPIC && this.activeTopic) {
      const nextTopic = this._getNextTopicFromPool(phaseTopics, this.activeTopic);
      if (nextTopic && nextTopic !== this.lastSuggestedTopic) {
        this.lastSuggestedTopic = nextTopic;
        const bridge = this._getBridgeHint(this.activeTopic, nextTopic);
        const d = `[SYSTEM: TOPIC SWITCH REQUIRED — You have covered "${this.activeTopic}" enough (${this.activeTopicTurns} turns). ` +
          `Switch to "${nextTopic}" NOW. Once you leave a topic, you cannot return to it. ` +
          `Transition hint: ${bridge}. ` +
          `Do NOT ask more questions about "${this.activeTopic}".]`;
        directives.push(d);
        logDirective(d);
      }
    } else if (this.activeTopicTurns === MAX_TURNS_PER_TOPIC - 1 && this.activeTopic) {
      // Gentle bookmark: prepare the transition
      const nextTopic = this._getNextTopicFromPool(phaseTopics, this.activeTopic);
      if (nextTopic) {
        const bridge = this._getBridgeHint(this.activeTopic, nextTopic);
        const d = `[SYSTEM: TOPIC BOOKMARK — You've spent ${this.activeTopicTurns} turns on "${this.activeTopic}". ` +
          `After one more exchange, transition to "${nextTopic}". ` +
          `Remember: once you leave "${this.activeTopic}", you cannot return to it. ` +
          `Hint: ${bridge}.]`;
        directives.push(d);
        logDirective(d);
      }
    }

    // ── Check if we should prompt a communicative function or rule ──
    // Only if no topic switch is happening this turn (avoid overloading with directives)
    if (directives.length === 0) {
      const fnDirectives = this._checkFunctionPrompt();
      directives.push(...fnDirectives);
    }

    return directives;
  }

  // ─── Timer check (called every 10s from useVoiceConnection) ────────
  checkTiming() {
    const directives = [];
    const elapsed = this.getElapsedMs();
    if (!this.minReached && elapsed >= this.minMs) {
      this.minReached = true;
      directives.push('[SYSTEM: Minimum conversation time reached. If the student says goodbye, you may end warmly.]');
    }
    if (!this.maxReached && elapsed >= this.maxMs) {
      this.maxReached = true;
      this.phase = 5;
      directives.push('[SYSTEM: Maximum time reached. Say farewell NOW.]');
    }
    return directives;
  }

  // ─── Mark that the student asked a question in Phase 4 ─────────────
  markPhase4Question() {
    this.phase4StudentAsked = true;
  }

  // ─── Data for /api/classify-topic ───────────────────────────────────
  getTopicsForClassification() {
    // Only classify against the current phase's topic pool
    if (this.phase === 2) {
      return {
        currentTopics: this.phase2Pool.topics,
        reviewTopics: [],
      };
    } else if (this.phase === 3) {
      return {
        currentTopics: this.phase3Pool.topics,
        reviewTopics: [],
      };
    }
    return { currentTopics: [], reviewTopics: [] };
  }

  getRemainingTopics() {
    const phaseTopics = this._getCurrentPhaseTopics();
    return phaseTopics.filter(t => !this.completedTopics.has(t) && (this.topicTurnCounts[t] || 0) < MAX_TURNS_PER_TOPIC);
  }

  reset() {
    this.phase = 1;
    this.startTime = null;
    this.phase1EndTime = null;
    this.postWarmupBudget = 0;
    this.phase2Deadline = 0;
    this.phase3Deadline = 0;
    this.phase4Deadline = 0;
    this.starters = this._initStarters();
    this.activeTopic = null;
    this.activeTopicTurns = 0;
    this.topicTurnCounts = {};
    this.completedTopics = new Set();
    this.aiTurnCount = 0;
    this.recentStudentUtterances = [];
    this.minReached = false;
    this.maxReached = false;
    this.phase2Signaled = false;
    this.phase3Signaled = false;
    this.phase4Signaled = false;
    this.phase5Signaled = false;
    this.phase4StudentAsked = false;
    this.lastSuggestedTopic = null;
    this.promptedFunctions = new Set();
    this.promptedRules = new Set();
    this.usedModelSentences = new Set();
    this.functionPromptCooldown = 0;
    this.lastFunctionPromptTurn = 0;
  }

  // ─── Internal: detect warm-up starters ──────────────────────────────
  _detectStarters(text) {
    const t = (text || '').toLowerCase();
    if (/wie hei[sß](t|en) (du|sie)\b/i.test(t) || /dein(en?)?\s*name/i.test(t)) {
      this.starters.name = true;
    }
    if ('howAreYou' in this.starters && (/wie geht[''']?s/i.test(t) || /wie geht es (dir|ihnen)/i.test(t))) {
      this.starters.howAreYou = true;
    }
    if ('origin' in this.starters && (/woher komm(st|en) (du|sie)\b/i.test(t) || /wo komm(st|en) (du|sie) her/i.test(t))) {
      this.starters.origin = true;
    }
    if ('currentPlace' in this.starters && /wo (wohn|leb)(st|en) (du|sie)\b/i.test(t)) {
      this.starters.currentPlace = true;
    }
  }

  _allStartersDone() { return Object.values(this.starters).every(v => v === true); }

  _missingStarters() {
    const labels = { name: '"Wie heißt du?"', howAreYou: '"Wie geht\'s?"', origin: '"Woher kommst du?"', currentPlace: '"Wo wohnst du?"' };
    return Object.entries(this.starters).filter(([, done]) => !done).map(([key]) => labels[key] || key);
  }
}
