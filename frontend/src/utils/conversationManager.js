/**
 * ConversationManager — Smart topic queue with contextual transition directives.
 *
 * KEY DESIGN:
 * - Maintains an ordered queue of ALL topics from the last 10 units + review pool
 * - Tracks which topics are covered, how many turns each has received
 * - Buffers recent student utterances for "bridge context"
 * - After 2-3 turns on a topic, generates a CONTEXTUAL transition directive that:
 *   (a) Names the SPECIFIC next topic to switch to
 *   (b) Includes the student's recent words as bridge material
 *   (c) Gives Claude a concrete example transition
 * - Claude handles the creative phrasing; the manager handles the sequencing
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

export class ConversationManager {
  constructor({ mainTopics = [], reviewTopics = [], currentUnitTopics = [], minMs, maxMs, chapterNumber = 1 }) {
    // Full topic lists
    this.mainTopics = mainTopics;           // All topics from last 10 units (current unit first)
    this.reviewTopics = reviewTopics;       // Topics from review pool (string[])
    this.currentUnitTopics = currentUnitTopics; // Just the current unit's topics

    // Build the topic queue: current unit topics first, then other main topics, then review
    this.topicQueue = this._buildQueue();

    // Duration thresholds
    this.minMs = minMs;
    this.maxMs = maxMs;
    this.chapterNumber = chapterNumber;

    // Phase: 1=warm-up, 2=main, 3=closing
    this.phase = 1;
    this.startTime = null;

    // Warm-up starters
    this.starters = this._initStarters();

    // Topic tracking
    this.activeTopic = null;               // Currently active topic name
    this.activeTopicTurns = 0;             // Turns on the active topic
    this.coveredTopics = new Set();        // Topics that have been covered (2+ turns)
    this.exhaustedTopics = new Set();      // Topics with 3+ turns (fully covered)
    this.topicTurnCounts = {};             // topic → total turn count
    this.turnPools = [];                   // per-turn pool classification
    this.aiTurnCount = 0;

    // Student utterance buffer (last 3 for bridge context)
    this.recentStudentUtterances = [];

    // Duration flags
    this.minReached = false;
    this.maxReached = false;
    this.phase3Signaled = false;
    this.phase2Signaled = false;

    // Track last transition directive to avoid repeating
    this.lastSuggestedTopic = null;
  }

  _buildQueue() {
    const queue = [];
    // Current unit topics first (highest priority)
    for (const t of this.currentUnitTopics) {
      if (t && !queue.includes(t)) queue.push(t);
    }
    // Then other main topics (last 10 units)
    for (const t of this.mainTopics) {
      if (t && !queue.includes(t)) queue.push(t);
    }
    // Then review topics
    for (const t of this.reviewTopics) {
      if (t && !queue.includes(t)) queue.push(t);
    }
    return queue;
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

  // ─── Get the next uncovered topic from the queue ────────────────────────
  _getNextTopic(excludeTopic = null) {
    for (const t of this.topicQueue) {
      if (t !== excludeTopic && !this.exhaustedTopics.has(t)) {
        return t;
      }
    }
    // All exhausted — return first non-active topic
    for (const t of this.topicQueue) {
      if (t !== excludeTopic) return t;
    }
    return null;
  }

  // ─── Build a bridge hint between two topics ─────────────────────────────
  _getBridgeHint(fromTopic, toTopic) {
    const key = `${fromTopic}→${toTopic}`;
    if (TOPIC_BRIDGES[key]) return TOPIC_BRIDGES[key];

    // Generic bridge using student context
    const recentWords = this.recentStudentUtterances.slice(-2).join(' ');
    if (recentWords) {
      return `The student recently said: "${recentWords}". Find a natural connection to "${toTopic}" from what they shared.`;
    }
    return `Find a natural way to transition to "${toTopic}".`;
  }

  // ─── Called immediately after each AI turn ──────────────────────────────
  processAITurn(aiText) {
    this.aiTurnCount++;
    const directives = [];
    const elapsed = this.getElapsedMs();

    // ── Phase 1: warm-up ──
    if (this.phase === 1) {
      this._detectStarters(aiText);

      if (this._allStartersDone()) {
        this.phase = 2;
        this.phase2Signaled = true;
        const firstTopic = this.topicQueue[0] || 'the current unit topic';
        directives.push(
          `[SYSTEM: Phase 1 complete — warm-up done. Move into Phase 2. ` +
          `Your first topic should be: "${firstTopic}". ` +
          `Use a natural topic transition. Do NOT repeat warm-up starters.]`
        );
      } else if (elapsed > this.maxMs * 0.30) {
        this.phase = 2;
        this.phase2Signaled = true;
        const missing = this._missingStarters();
        const firstTopic = this.topicQueue[0] || 'the current unit topic';
        directives.push(
          `[SYSTEM: Moving to Phase 2 (warm-up time limit). Missing: ${missing.join(', ')}. ` +
          `Start with topic: "${firstTopic}".]`
        );
      } else if (this.aiTurnCount === 2 && !this.starters.name) {
        directives.push('[SYSTEM: Ask "Wie heißt du?" now.]');
      }
    }

    // ── Min duration ──
    if (!this.minReached && elapsed >= this.minMs) {
      this.minReached = true;
      directives.push('[SYSTEM: Minimum conversation time reached. If the student says goodbye, you may end warmly.]');
    }

    // ── Phase 3 at 90% of max ──
    if (!this.phase3Signaled && this.phase === 2 && elapsed >= this.maxMs * 0.90) {
      this.phase = 3;
      this.phase3Signaled = true;
      directives.push('[SYSTEM: Approaching maximum time. Wrap up and prepare farewell.]');
    }

    // ── Hard max ──
    if (!this.maxReached && elapsed >= this.maxMs) {
      this.maxReached = true;
      this.phase = 3;
      directives.push('[SYSTEM: Maximum time reached. Say farewell NOW.]');
    }

    return directives;
  }

  // ─── Called when async topic classification returns ──────────────────────
  updateTopicClassification({ matchedTopics = [], pool = 'none' }) {
    const primaryTopic = matchedTopics[0] || null;

    // Update turn counts
    for (const t of matchedTopics) {
      this.coveredTopics.add(t);
      this.topicTurnCounts[t] = (this.topicTurnCounts[t] || 0) + 1;
      if (this.topicTurnCounts[t] >= 3) {
        this.exhaustedTopics.add(t);
      }
    }
    this.turnPools.push(pool);

    // Track active topic streak
    if (primaryTopic) {
      if (primaryTopic === this.activeTopic) {
        this.activeTopicTurns++;
      } else {
        this.activeTopic = primaryTopic;
        this.activeTopicTurns = 1;
        this.lastSuggestedTopic = null; // reset suggestion tracking on natural topic change
      }
    }

    const directives = [];
    if (this.phase !== 2) return directives;

    // ── TOPIC TRANSITION LOGIC ──

    // After 2 turns: gentle suggestion (bookmark for next turn)
    // After 3 turns: firm directive (must switch now)
    if (this.activeTopicTurns >= 3 && this.activeTopic) {
      const nextTopic = this._getNextTopic(this.activeTopic);
      if (nextTopic && nextTopic !== this.lastSuggestedTopic) {
        this.lastSuggestedTopic = nextTopic;
        const bridge = this._getBridgeHint(this.activeTopic, nextTopic);
        directives.push(
          `[SYSTEM: TOPIC SWITCH REQUIRED — You have covered "${this.activeTopic}" enough (${this.activeTopicTurns} turns). ` +
          `Switch to "${nextTopic}" NOW. ` +
          `Transition hint: ${bridge}. ` +
          `Do NOT ask more questions about "${this.activeTopic}".]`
        );
      }
    } else if (this.activeTopicTurns === 2 && this.activeTopic) {
      // Gentle bookmark: prepare the transition
      const nextTopic = this._getNextTopic(this.activeTopic);
      if (nextTopic) {
        const bridge = this._getBridgeHint(this.activeTopic, nextTopic);
        directives.push(
          `[SYSTEM: TOPIC BOOKMARK — You've spent 2 turns on "${this.activeTopic}". ` +
          `After one more exchange, transition to "${nextTopic}". ` +
          `Hint: ${bridge}. ` +
          `You may ask one more follow-up about "${this.activeTopic}" first, then switch.]`
        );
      }
    }

    // ── BALANCE CHECK (60/40) ──
    const recent = this.turnPools.slice(-6);
    if (recent.length >= 5) {
      const mainCount = recent.filter(p => p === 'current').length;
      const reviewCount = recent.filter(p => p === 'review').length;

      if (mainCount >= 5 && reviewCount === 0 && this.reviewTopics.length > 0) {
        const remainReview = this.reviewTopics.filter(t => !this.exhaustedTopics.has(t));
        if (remainReview.length > 0) {
          const nextReview = remainReview[0];
          const bridge = this._getBridgeHint(this.activeTopic, nextReview);
          directives.push(
            `[SYSTEM: BALANCE — Too many main topics in a row. Switch to review topic: "${nextReview}". ${bridge}]`
          );
        }
      } else if (reviewCount >= 5 && mainCount === 0) {
        const remainMain = this.mainTopics.filter(t => !this.exhaustedTopics.has(t));
        if (remainMain.length > 0) {
          const nextMain = remainMain[0];
          directives.push(
            `[SYSTEM: BALANCE — Too many review topics in a row. Switch to main topic: "${nextMain}".]`
          );
        }
      }
    }

    return directives;
  }

  // ─── Timer check ────────────────────────────────────────────────────────
  checkTiming() {
    const directives = [];
    const elapsed = this.getElapsedMs();
    if (!this.minReached && elapsed >= this.minMs) {
      this.minReached = true;
      directives.push('[SYSTEM: Minimum conversation time reached. If the student says goodbye, you may end warmly.]');
    }
    if (!this.maxReached && elapsed >= this.maxMs) {
      this.maxReached = true;
      this.phase = 3;
      directives.push('[SYSTEM: Maximum time reached. Say farewell NOW.]');
    }
    return directives;
  }

  // ─── Data for /api/classify-topic ───────────────────────────────────────
  getTopicsForClassification() {
    return {
      currentTopics: this.mainTopics,     // Full last-10 topic list
      reviewTopics: this.reviewTopics.map(t => ({ topic: t, chapter: 'Review' })),
    };
  }

  getRemainingTopics() {
    return this.topicQueue.filter(t => !this.exhaustedTopics.has(t));
  }

  reset() {
    this.phase = 1;
    this.startTime = null;
    this.starters = this._initStarters();
    this.activeTopic = null;
    this.activeTopicTurns = 0;
    this.coveredTopics = new Set();
    this.exhaustedTopics = new Set();
    this.topicTurnCounts = {};
    this.turnPools = [];
    this.aiTurnCount = 0;
    this.recentStudentUtterances = [];
    this.minReached = false;
    this.maxReached = false;
    this.phase3Signaled = false;
    this.phase2Signaled = false;
    this.lastSuggestedTopic = null;
  }

  // ─── Internal: detect warm-up starters ──────────────────────────────────
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
