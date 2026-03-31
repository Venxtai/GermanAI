import { useRef, useCallback } from "react";
import useAIStore from "../store/useAIStore";
import { generateUnitInstructions, getDurations, getBuddyFirstName } from "../utils/systemInstructions";
import { ConversationManager } from "../utils/conversationManager";

// Known hallucination phrases — stripped from every student transcript
const WHISPER_HALLUCINATIONS = [
  // Amara / community captions
  /untertitel der amara\.org-community/gi,
  /untertitel von \S+/gi,
  /amara\.org/gi,
  // ZDF / German public broadcaster caption credits
  /untertitel im auftrag des zdf[^.]*\d{4}/gi,
  /untertitel[:\s]+[a-z].{0,60}\d{4}/gi,
  /im auftrag des zdf/gi,
  /f[\u00fcu]r funk[,.]?/gi,
  // Generic German credit/caption footers
  /vielen dank f[\u00fcu]r['s]* zuschauen[.!]*/gi,
  /danke f[\u00fcu]rs zuschauen[.!]*/gi,
  /copyright \d{4}/gi,
  /alle rechte vorbehalten/gi,
  // Sound effect tags
  /\[musik\]/gi,
  /\[applaus\]/gi,
  /\[gel[\u00e4a]chter\]/gi,
  /\[stille\]/gi,
  /\[pause\]/gi,
  // Common English Whisper hallucinations
  /thank you for watching\.?/gi,
  /thanks for watching\.?/gi,
  /please subscribe\.?/gi,
  /don't forget to (like|subscribe|comment)\.?/gi,
  /like and subscribe\.?/gi,
  /see you (next time|in the next video)\.?/gi,
  /subtitles by .+/gi,
  /subtitled by .+/gi,
  /closed captions? by .+/gi,
  /transcribed by .+/gi,
  /^\s*you\s*$/gi,
  /^\s*bye\.?\s*$/gi,
  // URLs
  /www\.\S+/gi,
  /https?:\/\/\S+/gi,
];

function cleanTranscript(text) {
  if (!text) return text;
  let cleaned = text;
  for (const pattern of WHISPER_HALLUCINATIONS) {
    cleaned = cleaned.replace(pattern, "");
  }
  return cleaned.trim().replace(/\s{2,}/g, " ");
}

export function useVoiceConnection() {
  // ── Mic & recording refs ──
  const rawMicStreamRef = useRef(null);
  const microphoneTrackRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const isRecordingRef = useRef(false);
  const recordStartRef = useRef(null);

  // ── Session refs ──
  const sessionIdRef = useRef(null);
  const playbackContextRef = useRef(null);
  const currentAudioSourceRef = useRef(null);

  // ── Logging refs ──
  const logSessionIdRef = useRef(null);
  const logQueueRef = useRef(Promise.resolve());

  // ── Name handling refs ──
  const studentNameRef = useRef(null);
  const typedNameRef = useRef(null);
  const nameConfirmationPendingRef = useRef(null);
  const pendingNameCorrectionRef = useRef(null);
  const expectingNameRef = useRef(false); // true after buddy asks "Wie heißt du?"

  // ── Session state refs ──
  const studentUtterancesRef = useRef([]);
  const unitDataRef = useRef(null);
  const conversationStartRef = useRef(null);
  const conversationTimerRef = useRef(null);
  const silentStudentTimerRef = useRef(null);
  const exchangeCountRef = useRef(0);
  const topicsDiscussedRef = useRef(new Set());
  const minDurationFiredRef = useRef(false);
  const maxDurationFiredRef = useRef(false);
  const pendingEndAfterTurnRef = useRef(false);
  const endConversationRef = useRef(null);
  const managerRef = useRef(null);
  const systemInstructionsRef = useRef(null);
  const pendingDirectivesRef = useRef([]);

  // ── Logging helper ──
  const postLogRef = useRef(null);
  postLogRef.current = (payload) => {
    if (!logSessionIdRef.current) return Promise.resolve();
    return fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, sessionId: logSessionIdRef.current }),
    }).catch(() => {});
  };
  function postLog(payload) {
    logQueueRef.current = logQueueRef.current.then(
      () => postLogRef.current?.(payload) ?? Promise.resolve()
    );
  }

  const {
    setStatus,
    setSessionActive,
    addMessage,
    finalizeAIMessage,
    clearMessages,
    currentUnit,
    setAnalyzerNode,
    setTranscriptForDownload,
    setMicError,
    setFeedback,
    setVisemeTimeline,
    clearVisemeTimeline,
  } = useAIStore();

  // ── Audio playback helper ──
  async function playAudio(audioBase64, mimeType = 'audio/wav', visemeData = null) {
    // Set viseme timeline in store BEFORE starting playback
    if (visemeData && visemeData.length > 0) {
      setVisemeTimeline(visemeData);
    }
    if (!playbackContextRef.current || playbackContextRef.current.state === 'closed') {
      playbackContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ctx = playbackContextRef.current;
    await ctx.resume();

    // Decode base64 to ArrayBuffer
    const binaryStr = atob(audioBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;

    // Analyser for lipsync
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    setAnalyzerNode(analyser);

    currentAudioSourceRef.current = source;

    return new Promise((resolve) => {
      source.onended = () => {
        currentAudioSourceRef.current = null;
        setAnalyzerNode(null);
        clearVisemeTimeline();
        resolve();
      };
      source.start();
      setStatus('speaking');
    });
  }

  // ── Directive-only prompt (no student audio) ──
  async function sendPromptTurn(directives) {
    const sid = sessionIdRef.current;
    if (!sid) return;

    try {
      const resp = await fetch('/api/session/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, directives }),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.response) {
        addMessage('assistant', data.response);
        postLog({ type: 'turn', role: 'ai', text: data.response });
        await playAudio(data.audioBase64, data.mimeType, data.visemeTimeline);
        setStatus('idle');

        // Handle pending auto-end after AI speaks
        if (pendingEndAfterTurnRef.current) {
          pendingEndAfterTurnRef.current = false;
          endConversationRef.current?.();
          return;
        }
        // Start silent-student timer
        startSilentStudentTimer();
      }
    } catch (err) {
      console.error('[Prompt Turn] Error:', err);
      setStatus('idle');
    }
  }

  function startSilentStudentTimer() {
    clearTimeout(silentStudentTimerRef.current);
    silentStudentTimerRef.current = setTimeout(() => {
      if (!isRecordingRef.current && sessionIdRef.current) {
        sendPromptTurn([
          '[SYSTEM: The student has been silent for a while. Prompt them gently with a simple, encouraging question using vocabulary from the current unit.]',
        ]);
      }
    }, 30000);
  }

  // ── Name detection helper ──
  // ANTICIPATION-BASED: After the buddy asks "Wie heißt du?", we set
  // expectingNameRef=true. The NEXT student turn is expected to contain their
  // name. We extract the name using multiple strategies (grammar patterns,
  // last capitalized word, etc.) rather than relying on Whisper getting
  // "heiße" right (it often transcribes it as "hasse", "heise", etc.).

  // Detect if the buddy just asked for the student's name
  function checkBuddyAskedName(aiText) {
    if (!aiText || studentNameRef.current) return;
    const t = aiText.toLowerCase();
    if (/wie hei[sß](t|en) (du|sie)/i.test(t) || /dein(en?)?\s*name/i.test(t)) {
      expectingNameRef.current = true;
    }
  }

  function handleNameDetection(transcript, aiText) {
    // Step 1: If awaiting name confirmation (completely different names), parse response
    if (nameConfirmationPendingRef.current && transcript) {
      const { typed, spoken } = nameConfirmationPendingRef.current;
      nameConfirmationPendingRef.current = null;
      const mentionsTyped = transcript.toLowerCase().includes(typed.toLowerCase());
      const confirmedName = mentionsTyped ? typed : spoken;
      studentNameRef.current = confirmedName;
      expectingNameRef.current = false;
      fetch('/api/session/update-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          promptAddition: `CRITICAL — The student's confirmed name is "${confirmedName}". You MUST use ONLY this exact spelling for the rest of the session.`,
        }),
      }).catch(() => {});
      return;
    }

    // Step 2: Extract name from student's response
    if (!studentNameRef.current && transcript) {
      let spokenName = null;

      // Strategy A: Classic grammar patterns (works when Whisper gets it right)
      const grammarMatch =
        transcript.match(/ich hei[sß]e\s+([^\s.,!?]+)/i) ||
        transcript.match(/mein name ist\s+([^\s.,!?]+)/i) ||
        transcript.match(/ich bin\s+([^\s.,!?]+)/i);
      if (grammarMatch) {
        spokenName = grammarMatch[1];
      }

      // Strategy B: Anticipation — if we're expecting a name, extract it
      // even from garbled transcriptions like "Ich hasse Nico" or just "Nico"
      if (!spokenName && expectingNameRef.current) {
        // Try: "ich [anything] [Name]" — last capitalized word after "ich"
        const afterIch = transcript.match(/ich\s+\S+\s+([A-Z][a-zA-ZäöüÄÖÜß]+)/);
        if (afterIch) {
          spokenName = afterIch[1];
        }
        // Try: just a standalone name (capitalized word, not "Ich")
        if (!spokenName) {
          const words = transcript.split(/\s+/).filter(w => /^[A-Z]/.test(w) && w.toLowerCase() !== 'ich');
          if (words.length === 1) {
            spokenName = words[0];
          } else if (words.length > 1) {
            // Take the last capitalized word (most likely the name)
            spokenName = words[words.length - 1];
          }
        }
        // Last resort: take the last word of the whole response
        if (!spokenName) {
          const lastWord = transcript.trim().split(/\s+/).pop();
          if (lastWord && lastWord.length >= 2 && !/^(ja|nein|gut|und|oder|nicht|das|die|der)$/i.test(lastWord)) {
            spokenName = lastWord.charAt(0).toUpperCase() + lastWord.slice(1);
          }
        }
      }

      if (!spokenName) return;
      expectingNameRef.current = false;

      const typedName = typedNameRef.current;

      if (typedName && spokenName.charAt(0).toLowerCase() !== typedName.charAt(0).toLowerCase()) {
        // Completely different first letters → ask for clarification
        nameConfirmationPendingRef.current = { typed: typedName, spoken: spokenName };
        pendingDirectivesRef.current.push(
          `[SYSTEM: The student typed "${typedName}" on the welcome screen but just said "${spokenName}". ` +
          `You MUST ask for clarification in German: "Interessant — heißt du ${typedName} oder ${spokenName}?" Then wait for confirmation.]`
        );
      } else {
        // Approximate match or no typed name → lock in typed spelling
        const finalName = typedName || spokenName;
        studentNameRef.current = finalName;
        fetch('/api/session/update-prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionIdRef.current,
            promptAddition: `CRITICAL — The student's confirmed name is "${finalName}". You MUST use ONLY this exact spelling for the rest of the session.`,
          }),
        }).catch(() => {});
      }
    }
  }

  // ── Start conversation ──
  const startConversation = useCallback(
    async (unitData, studentName = '') => {
      setStatus("loading");
      clearMessages();

      try {
        // 1. Microphone access
        const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
        rawMicStreamRef.current = ms;
        microphoneTrackRef.current = ms.getTracks()[0];

        // 2. Fetch persona
        let persona = null;
        try {
          const book = unitData._book || 'ID1';
          const chapter = unitData._chapter || 1;
          const pr = await fetch('/api/persona', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ book, chapter }),
          });
          if (pr.ok) persona = (await pr.json()).persona || null;
        } catch (e) {
          console.warn('[Persona] Failed:', e.message);
        }

        // 3. Generate system instructions
        const systemInstructions = generateUnitInstructions(unitData, persona, studentName);
        systemInstructionsRef.current = systemInstructions;
        const buddyName = getBuddyFirstName(persona);

        // 4. Reset refs
        studentNameRef.current = null;
        typedNameRef.current = studentName || null;
        nameConfirmationPendingRef.current = null;
        pendingNameCorrectionRef.current = null;
        expectingNameRef.current = false;
        unitDataRef.current = unitData;
        exchangeCountRef.current = 0;
        topicsDiscussedRef.current = new Set();
        minDurationFiredRef.current = false;
        maxDurationFiredRef.current = false;
        conversationStartRef.current = Date.now();
        pendingEndAfterTurnRef.current = false;
        pendingDirectivesRef.current = [];

        // 5. Initialize ConversationManager
        const { minMs, maxMs } = getDurations(unitData._book || 'ID1', unitData._chapter || 1);
        const chapterNumber = unitData._cumulative?.chapterNumber || unitData._chapter || 1;

        // Build full topic lists from last-10 tiers + review data
        const currentUnitTopics = unitData.conversation_topics?.topics || [];
        const last10AllTopics = [];
        for (const tier of (unitData._cumulative?.last10Tiers || [])) {
          for (const t of (tier.topics || [])) {
            if (t && !last10AllTopics.includes(t)) last10AllTopics.push(t);
          }
        }
        // Ensure current unit topics are at the front
        const mainTopics = [...currentUnitTopics];
        for (const t of last10AllTopics) {
          if (!mainTopics.includes(t)) mainTopics.push(t);
        }

        const reviewTopicData = (unitData._cumulative?.reviewTopics || [])
          .map(rt => typeof rt === 'string' ? rt : rt.topic)
          .filter(t => t && !mainTopics.includes(t)); // exclude overlap with main

        managerRef.current = new ConversationManager({
          mainTopics,         // ALL topics from last 10 units (current unit first)
          reviewTopics: reviewTopicData,  // Topics from review pool (earlier units)
          currentUnitTopics,  // Just the current unit's topics (for priority tracking)
          minMs,
          maxMs,
          chapterNumber,
        });
        managerRef.current.start();

        // 6. Timer: delegates to ConversationManager every 10s
        conversationTimerRef.current = setInterval(() => {
          const mgr = managerRef.current;
          if (!mgr) return;
          const directives = mgr.checkTiming();
          if (directives.length > 0) {
            pendingDirectivesRef.current.push(...directives);
          }
          // Hard max: auto-end after AI delivers closing line
          if (mgr.maxReached && !pendingEndAfterTurnRef.current) {
            pendingEndAfterTurnRef.current = true;
            clearInterval(conversationTimerRef.current);
            // Trigger a closing turn via directive
            sendPromptTurn([
              '[SYSTEM: Maximum conversation time reached. You MUST say your natural closing farewell NOW in one sentence. The session will end after this response.]',
            ]);
          }
        }, 10000);

        // 7. Start session on server — ALWAYS ask name as part of warm-up ritual
        const openingText = `[Session started. This is Phase 1 (warm-up). Your name is ${buddyName}. Say: "Hallo! Ich bin ${buddyName} — wie heißt du?" ALWAYS ask the student's name even if you have a spelling reference. Do NOT ask about the unit topic yet. Speak only in German.]`;

        // Send cumulative data for server-side vocabulary validation
        const cumulativeData = unitData._cumulative ? {
          activeVocabulary: unitData._cumulative.activeVocabulary,
          passiveVocabulary: unitData._cumulative.passiveVocabulary,
          verbForms: unitData._cumulative.verbForms,
        } : null;

        const sessionResp = await fetch('/api/session/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemPrompt: systemInstructions,
            openingInstruction: openingText,
            typedStudentName: studentName || null,
            cumulativeData,
            grammarConstraints: unitData.grammar_constraints || null,
            universalFillers: unitData.universal_fillers || null,
          }),
        });
        if (!sessionResp.ok) throw new Error('Session start failed');
        const { sessionId, response: aiGreeting, audioBase64, mimeType, visemeTimeline: greetingVisemes } = await sessionResp.json();
        sessionIdRef.current = sessionId;

        // 8. Start log session
        logSessionIdRef.current = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        postLog({
          type: 'start',
          unit: unitData?.unit,
          unitTitle: (unitData?.communicative_functions?.goals || [])[0]
                  || (unitData?.conversation_topics?.topics || [])[0]
                  || '',
        });

        // 9. Add AI greeting to messages and process through manager
        addMessage('assistant', aiGreeting);
        postLog({ type: 'turn', role: 'ai', text: aiGreeting });
        checkBuddyAskedName(aiGreeting); // Track if buddy asked "Wie heißt du?"

        const mgr = managerRef.current;
        if (mgr) {
          const directives = mgr.processAITurn(aiGreeting);
          if (directives.length > 0) pendingDirectivesRef.current.push(...directives);
          // Skip topic classification during Phase 1 — warm-up doesn't count
        }

        // 10. Play greeting audio and go live
        setSessionActive(true);
        try {
          await playAudio(audioBase64, mimeType, greetingVisemes);
        } catch (audioErr) {
          console.error("Audio playback failed (non-fatal):", audioErr);
          // Session still works — student can speak even if greeting audio failed
        }
        setStatus('idle');
        startSilentStudentTimer();

      } catch (err) {
        console.error("Error starting conversation:", err);
        setSessionActive(false);
        setStatus("idle");
        throw err;
      }
    },
    [currentUnit, setStatus, setSessionActive, clearMessages, setAnalyzerNode, addMessage]
  );

  // ── End conversation ──
  const endConversation = useCallback(() => {
    pendingEndAfterTurnRef.current = false;
    // Snapshot for feedback
    const utterancesSnapshot = [...studentUtterancesRef.current];
    const sessionDurationMs = conversationStartRef.current ? Date.now() - conversationStartRef.current : 0;
    const unitNumber = unitDataRef.current?.unit ?? null;
    const { minMs: minDurationMs } = getDurations(unitDataRef.current?._book || 'ID1', unitDataRef.current?._chapter || 1);
    studentUtterancesRef.current = [];
    setFeedback('loading');

    // Save sessionId before clearing — postLog is async and needs it
    const endLogSessionId = logSessionIdRef.current;
    const endSessionId = sessionIdRef.current;
    const storeState = useAIStore.getState();
    const accessCode = storeState.accessCode || '';
    const accessType = storeState.accessType || '';
    const assignedTo = storeState.assignedTo || '';
    const studentNameForLog = studentNameRef.current || typedNameRef.current || '';
    const unitForLog = unitDataRef.current
      ? `Unit ${unitDataRef.current.unit} — ${(unitDataRef.current.conversation_topics?.topics || [])[0] || ''}`
      : '';
    const durationMin = conversationStartRef.current
      ? Math.round((Date.now() - conversationStartRef.current) / 60000 * 10) / 10
      : 0;

    postLog({ type: 'end' });

    // Log session details to Usage Log (fills in Student Name, Unit, Duration columns)
    fetch('/api/auth/log-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: accessCode,
        type: accessType,
        unit: unitForLog,
        sessionId: endLogSessionId || endSessionId || '',
        durationMin,
        studentName: studentNameForLog,
        assignedTo,
      }),
    }).catch(() => {});

    // Delay clearing logSessionId so the queued postLog can fire
    setTimeout(() => { logSessionIdRef.current = null; }, 2000);

    // Reset manager and timers
    if (managerRef.current) { managerRef.current.reset(); managerRef.current = null; }
    clearInterval(conversationTimerRef.current);
    conversationTimerRef.current = null;
    clearTimeout(silentStudentTimerRef.current);
    silentStudentTimerRef.current = null;
    conversationStartRef.current = null;
    unitDataRef.current = null;
    exchangeCountRef.current = 0;
    topicsDiscussedRef.current = new Set();
    minDurationFiredRef.current = false;
    maxDurationFiredRef.current = false;
    pendingDirectivesRef.current = [];

    // Stop audio playback
    if (currentAudioSourceRef.current) {
      try { currentAudioSourceRef.current.stop(); } catch (_) {}
      currentAudioSourceRef.current = null;
    }
    if (playbackContextRef.current) {
      playbackContextRef.current.close().catch(() => {});
      playbackContextRef.current = null;
    }

    // Stop recording
    isRecordingRef.current = false;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];

    // Stop mic
    if (microphoneTrackRef.current) {
      microphoneTrackRef.current.stop();
      microphoneTrackRef.current = null;
    }
    rawMicStreamRef.current = null;

    // Clear session
    sessionIdRef.current = null;
    studentNameRef.current = null;
    systemInstructionsRef.current = null;
    pendingNameCorrectionRef.current = null;
    typedNameRef.current = null;
    nameConfirmationPendingRef.current = null;
    logQueueRef.current = Promise.resolve();

    setAnalyzerNode(null);
    setSessionActive(false);
    setStatus("idle");

    // Async feedback
    if (unitNumber && utterancesSnapshot.length > 0) {
      fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ utterances: utterancesSnapshot, unit: unitNumber, sessionDurationMs, minDurationMs, sessionId: sessionIdRef.current }),
      })
        .then(r => r.json())
        .then(data => setFeedback(data))
        .catch(() => setFeedback({ fallback: true }));
    } else {
      setFeedback({ fallback: true });
    }
    // Save transcript for download before clearing
    const msgs = useAIStore.getState().messages;
    const unitLabel = unitDataRef.current
      ? `Unit ${unitDataRef.current.unit} — ${(unitDataRef.current.communicative_functions?.goals || [])[0] || (unitDataRef.current.conversation_topics?.topics || [])[0] || ''}`
      : '';
    setTranscriptForDownload({ messages: [...msgs], unitLabel, date: new Date().toLocaleString() });
    clearMessages();
  }, [setSessionActive, setStatus, clearMessages, setAnalyzerNode, setFeedback, setTranscriptForDownload]);
  endConversationRef.current = endConversation;

  // ── Start recording ──
  const startRecording = useCallback(() => {
    const track = microphoneTrackRef.current;
    if (!track) { console.warn('[Recording] no mic track'); return; }
    isRecordingRef.current = true;
    clearTimeout(silentStudentTimerRef.current);
    recordStartRef.current = Date.now();
    audioChunksRef.current = [];
    setMicError(null);

    const stream = rawMicStreamRef.current;
    if (stream) {
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
      const mr = new MediaRecorder(stream, { mimeType });
      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.start(100);
      mediaRecorderRef.current = mr;
    }
    setStatus('listening');
  }, [setStatus, setMicError]);

  // ── Stop recording & run pipeline ──
  const stopRecording = useCallback(async () => {
    if (!isRecordingRef.current) return;
    isRecordingRef.current = false;

    const holdMs = Date.now() - (recordStartRef.current || 0);
    const mr = mediaRecorderRef.current;

    // Too-short hold
    if (holdMs < 500) {
      if (mr && mr.state !== 'inactive') mr.stop();
      audioChunksRef.current = [];
      setMicError("Hold the button while you speak, then release.");
      setStatus('idle');
      return;
    }

    setStatus('loading');

    // Stop MediaRecorder and assemble blob
    const audioBlob = await new Promise((resolve) => {
      if (!mr || mr.state === 'inactive') {
        resolve(new Blob(audioChunksRef.current, { type: 'audio/webm' }));
        return;
      }
      mr.onstop = () => {
        resolve(new Blob(audioChunksRef.current, { type: mr.mimeType || 'audio/webm' }));
      };
      mr.stop();
    });

    try {
      // Build form data
      const fd = new FormData();
      fd.append('audio', audioBlob, 'audio.webm');
      fd.append('sessionId', sessionIdRef.current);

      // Flush pending directives
      const directives = pendingDirectivesRef.current.splice(0);
      if (directives.length > 0) {
        fd.append('directives', JSON.stringify(directives));
      }

      const resp = await fetch('/api/conversation-turn', { method: 'POST', body: fd });
      if (!resp.ok) throw new Error(`Pipeline failed: ${resp.status}`);
      const { transcript, response: aiText, audioBase64, mimeType, visemeTimeline: turnVisemes } = await resp.json();

      // ── Process transcript ──
      const cleaned = cleanTranscript(transcript) || '(inaudible)';
      if (cleaned !== '(inaudible)') {
        studentUtterancesRef.current.push(cleaned);
        // Feed to ConversationManager for bridge context
        managerRef.current?.addStudentUtterance(cleaned);
      }
      exchangeCountRef.current += 1;

      addMessage('user', cleaned);
      postLog({ type: 'turn', role: 'student', text: cleaned });

      // Name detection
      if (cleaned !== '(inaudible)') {
        // Farewell detection
        const isFarewell = /\b(tsch[uü]ss|auf wiedersehen|tschau|ciao|bye|goodbye|auf wiederschauen|macht's gut|bis dann|bis später)\b/i.test(cleaned);
        if (isFarewell) {
          if (managerRef.current?.isMinDurationReached()) {
            pendingEndAfterTurnRef.current = true;
            // The AI's response (aiText) should already be the farewell
          } else {
            // Too early — directive already in response since server handles full history
            // But add one for safety
            pendingDirectivesRef.current.push(
              '[SYSTEM: The student tried to say goodbye but the minimum conversation time has NOT been reached. You MUST continue the conversation.]'
            );
          }
        }
        handleNameDetection(cleaned, aiText);
      }

      // ── Process AI response ──
      addMessage('assistant', aiText);
      postLog({ type: 'turn', role: 'ai', text: aiText });
      checkBuddyAskedName(aiText); // Track if buddy asked "Wie heißt du?"

      // ConversationManager processing
      const mgr = managerRef.current;
      if (mgr && aiText) {
        const mgrDirectives = mgr.processAITurn(aiText);
        if (mgrDirectives.length > 0) pendingDirectivesRef.current.push(...mgrDirectives);

        // Only classify topics during Phase 2+ (Phase 1 warm-up doesn't count)
        if (mgr.getPhase() >= 2) {
          const { currentTopics: ct, reviewTopics: rt } = mgr.getTopicsForClassification();
          if (ct.length > 0 || rt.length > 0) {
            fetch('/api/classify-topic', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: aiText, currentTopics: ct, reviewTopics: rt }),
            }).then(r => r.json()).then(result => {
              const bd = mgr.updateTopicClassification(result);
              if (bd.length > 0) pendingDirectivesRef.current.push(...bd);
            }).catch(() => {});
          }
        }
      }

      // Play AI audio with viseme timeline
      await playAudio(audioBase64, mimeType, turnVisemes);
      setStatus('idle');

      // Handle pending auto-end (student said goodbye earlier)
      if (pendingEndAfterTurnRef.current) {
        pendingEndAfterTurnRef.current = false;
        endConversationRef.current?.();
        return;
      }

      // Detect if the BUDDY just said goodbye (max-time triggered farewell)
      if (aiText && managerRef.current?.isMinDurationReached()) {
        const buddyFarewell = /\b(tsch[uü]ss|auf wiedersehen|tschau|ciao|bye|macht['']s gut|bis dann|bis bald|bis zum n[aä]chsten mal)\b/i.test(aiText);
        if (buddyFarewell) {
          // Auto-end after buddy farewell
          endConversationRef.current?.();
          return;
        }
      }

      // Start silent-student timer
      startSilentStudentTimer();

    } catch (err) {
      console.error('[Pipeline] Error:', err);
      setStatus('idle');
      setMicError('Something went wrong. Try again.');
    }
  }, [setStatus, setMicError, addMessage]);

  return {
    startConversation,
    endConversation,
    startRecording,
    stopRecording,
    isRecordingRef,
  };
}
