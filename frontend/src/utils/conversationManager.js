/**
 * ConversationManager — Application-level enforcement of conversation phases,
 * topic balance, warm-up starters, and timing.
 *
 * Instantiated per session in useVoiceConnection. After each AI turn or timer
 * tick, returns an array of directive strings to inject as [SYSTEM: ...] messages.
 *
 * ARCHITECTURE:
 * - Phase tracking: 1 (warm-up) → 2 (main) → 3 (closing)
 * - Phase 1 exit: content-based (all 3 starters done) with 30% time failsafe
 * - Phase 2 topic balance: hard enforcement — if last 4+ AI turns are all one
 *   pool (current or review), inject a MUST directive
 * - Phase 3 entry: at 90% of max duration
 * - Topic classification: async LLM call (GPT-4o-mini) via /api/classify-topic
 *
 * FILE: frontend/src/utils/conversationManager.js
 */

export class ConversationManager {
  constructor({ currentTopics = [], reviewTopics = [], minMs, maxMs, studentNameKnown = false }) {
    // Topic data from the unit
    this.currentTopics = currentTopics;        // string[] — current unit topics
    this.reviewTopics = reviewTopics;          // {chapter, topic}[] — from _cumulative

    // Duration thresholds
    this.minMs = minMs;
    this.maxMs = maxMs;

    // Phase: 1=warm-up, 2=main, 3=closing
    this.phase = 1;
    this.startTime = null;

    // Warm-up starter tracking — detect via regex on AI transcripts
    // Pre-mark name as done if the student already typed their name on the welcome screen
    this.starters = { name: studentNameKnown, origin: false, howAreYou: false };

    // Topic tracking — populated by async classification results
    this.coveredTopics = new Set();    // topic names confirmed covered
    this.turnPools = [];               // per-AI-turn pool: 'current'|'review'|'warmup'|'none'
    this.aiTurnCount = 0;

    // Duration flags — prevent duplicate directives
    this.minReached = false;
    this.maxReached = false;
    this.phase3Signaled = false;
    this.phase2Signaled = false;
  }

  start() {
    this.startTime = Date.now();
  }

  getElapsedMs() {
    return this.startTime ? Date.now() - this.startTime : 0;
  }

  isMinDurationReached() {
    return this.getElapsedMs() >= this.minMs;
  }

  getPhase() {
    return this.phase;
  }

  // ─── Called immediately after each AI turn ───────────────────────────────
  // Returns directive strings for phase transitions, timing, and starter nudges.
  // Topic balance enforcement happens separately in updateTopicClassification()
  // because the LLM classification is async.
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
        directives.push(
          '[SYSTEM: Phase 1 complete — all three warm-up starters have been covered. ' +
          'Move into Phase 2 now. Start with a CURRENT CHAPTER topic from Section 4. ' +
          'Remember: the warm-up starters are done — do NOT repeat them.]'
        );
      } else if (elapsed > this.maxMs * 0.30) {
        // Time failsafe: force Phase 2 even if starters aren't all done
        this.phase = 2;
        this.phase2Signaled = true;
        const missing = this._missingStarters();
        directives.push(
          `[SYSTEM: Moving to Phase 2 (time limit for warm-up reached). ` +
          `Still missing: ${missing.join(', ')}. ` +
          `Try to cover these naturally, then focus on CURRENT CHAPTER topics from Section 4.]`
        );
      } else if (this.aiTurnCount === 2 && !this.starters.name) {
        // Nudge: AI has spoken twice and still hasn't asked the name
        directives.push(
          '[SYSTEM: You have not asked the student\'s name yet. ' +
          'Ask "Wie heißt du?" in your very next turn.]'
        );
      }
    }

    // ── Min duration ──
    if (!this.minReached && elapsed >= this.minMs) {
      this.minReached = true;
      directives.push(
        '[SYSTEM: Minimum conversation time reached. ' +
        'If the student says goodbye, you may end warmly. Otherwise keep going naturally.]'
      );
    }

    // ── Phase 3 at 90% of max ──
    if (!this.phase3Signaled && this.phase === 2 && elapsed >= this.maxMs * 0.90) {
      this.phase = 3;
      this.phase3Signaled = true;
      directives.push(
        '[SYSTEM: Approaching maximum conversation time. ' +
        'Begin closing naturally — wrap up the current topic and prepare your farewell.]'
      );
    }

    // ── Hard max ──
    if (!this.maxReached && elapsed >= this.maxMs) {
      this.maxReached = true;
      this.phase = 3;
      directives.push(
        '[SYSTEM: Maximum conversation time reached. ' +
        'You MUST say your closing farewell NOW in your very next turn.]'
      );
    }

    return directives;
  }

  // ─── Called when async topic classification returns ──────────────────────
  // Records which topics were covered and enforces the 60/40 balance.
  updateTopicClassification({ matchedTopics = [], pool = 'none' }) {
    for (const t of matchedTopics) {
      this.coveredTopics.add(t);
    }
    this.turnPools.push(pool);

    const directives = [];

    // Only enforce balance during Phase 2
    if (this.phase !== 2) return directives;

    // Check balance over last 5 AI turns (need at least 4 data points)
    const recent = this.turnPools.slice(-5);
    if (recent.length < 4) return directives;

    const currentCount = recent.filter(p => p === 'current').length;
    const reviewCount  = recent.filter(p => p === 'review').length;

    if (currentCount >= 4 && reviewCount === 0) {
      directives.push(
        '[SYSTEM: TOPIC BALANCE — You have discussed only current chapter topics for several turns. ' +
        'You MUST ask about a REVIEW topic from an earlier chapter in your very next turn. ' +
        'Choose from the REVIEW TOPICS list in Section 4.]'
      );
    } else if (reviewCount >= 4 && currentCount === 0) {
      directives.push(
        '[SYSTEM: TOPIC BALANCE — You have discussed only review topics for several turns. ' +
        'You MUST ask about a CURRENT CHAPTER topic in your very next turn. ' +
        'Choose from the CURRENT CHAPTER TOPICS list in Section 4.]'
      );
    }

    return directives;
  }

  // ─── Called periodically by the timer (every 10s) ───────────────────────
  // Handles timing-based events that should fire even when nobody is speaking.
  checkTiming() {
    const directives = [];
    const elapsed = this.getElapsedMs();

    if (!this.minReached && elapsed >= this.minMs) {
      this.minReached = true;
      directives.push(
        '[SYSTEM: Minimum conversation time reached. ' +
        'If the student says goodbye, you may end warmly.]'
      );
    }

    if (!this.maxReached && elapsed >= this.maxMs) {
      this.maxReached = true;
      this.phase = 3;
      directives.push(
        '[SYSTEM: Maximum conversation time reached. ' +
        'You MUST say your closing farewell NOW.]'
      );
    }

    return directives;
  }

  // ─── Data for the /api/classify-topic call ──────────────────────────────
  getTopicsForClassification() {
    return {
      currentTopics: this.currentTopics,
      reviewTopics: this.reviewTopics,
    };
  }

  // ─── Topics not yet covered (for optional nudging) ──────────────────────
  getRemainingTopics() {
    const all = [
      ...this.currentTopics,
      ...this.reviewTopics.map(t => typeof t === 'string' ? t : t.topic),
    ];
    return all.filter(t => !this.coveredTopics.has(t));
  }

  reset() {
    this.phase = 1;
    this.startTime = null;
    this.starters = { name: false, origin: false, howAreYou: false };
    this.coveredTopics = new Set();
    this.turnPools = [];
    this.aiTurnCount = 0;
    this.minReached = false;
    this.maxReached = false;
    this.phase3Signaled = false;
    this.phase2Signaled = false;
  }

  // ─── Internal: detect warm-up starters in AI transcript ─────────────────
  _detectStarters(text) {
    const t = (text || '').toLowerCase();
    // Name: "Wie heißt du?" / "Wie heißen Sie?" / "dein Name" / "Wie ist dein Name?"
    if (/wie hei[sß](t|en) (du|sie)\b/i.test(t) || /dein(en?)?\s*name/i.test(t) || /wie ist (dein|ihr) name/i.test(t)) {
      this.starters.name = true;
    }
    // Origin: "Woher kommst du?" / "Wo kommst du her?"
    if (/woher komm(st|en) (du|sie)\b/i.test(t) || /wo komm(st|en) (du|sie) her/i.test(t)) {
      this.starters.origin = true;
    }
    // How are you: "Wie geht's?" / "Wie geht es dir/Ihnen?"
    if (/wie geht[''']?s/i.test(t) || /wie geht es (dir|ihnen)/i.test(t)) {
      this.starters.howAreYou = true;
    }
  }

  _allStartersDone() {
    return this.starters.name && this.starters.origin && this.starters.howAreYou;
  }

  _missingStarters() {
    const m = [];
    if (!this.starters.name)      m.push('"Wie heißt du?"');
    if (!this.starters.origin)    m.push('"Woher kommst du?"');
    if (!this.starters.howAreYou) m.push('"Wie geht\'s?"');
    return m;
  }
}
