import { useRef, useCallback, useEffect } from "react";
import { createWLipSyncNode } from "wlipsync";
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
  const lipsyncProfileRef = useRef(null);
  const lipsyncNodeRef = useRef(null);
  const micAudioCtxRef = useRef(null);

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
  const endReasonRef = useRef(null); // Tracks why conversation ended
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
    setLipsyncNode,
    clearLipsyncNode,
    setCurrentEmotion,
    setEmotionTimeline,
    clearEmotionTimeline,
    setSessionTiming,
    setMicAnalyser,
  } = useAIStore();

  // ── Audio playback helper (legacy — for non-streaming fallback) ──
  async function playAudio(audioBase64, mimeType = 'audio/wav', emotionTimeline = null) {
    if (!playbackContextRef.current || playbackContextRef.current.state === 'closed') {
      playbackContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
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

    // Analyser for amplitude (used by Character.jsx as a speaking gate)
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;

    // Create wLipSync node for real-time phoneme detection
    try {
      if (!lipsyncProfileRef.current) {
        lipsyncProfileRef.current = await fetch('/profile.json').then(r => r.json());
      }
      if (lipsyncNodeRef.current) {
        try { lipsyncNodeRef.current.disconnect(); } catch (_) {}
      }
      const lipsyncNode = await createWLipSyncNode(ctx, lipsyncProfileRef.current);
      lipsyncNodeRef.current = lipsyncNode;
      setLipsyncNode(lipsyncNode);

      const delayNode = ctx.createDelay(0.1);
      delayNode.delayTime.value = 0.05;
      source.connect(analyser);
      analyser.connect(delayNode);
      delayNode.connect(ctx.destination);
      source.connect(lipsyncNode);
    } catch (err) {
      console.warn('[wLipSync] Failed to create node, falling back to amplitude-only:', err);
      const delayNode = ctx.createDelay(0.1);
      delayNode.delayTime.value = 0.05;
      source.connect(analyser);
      analyser.connect(delayNode);
      delayNode.connect(ctx.destination);
    }

    setAnalyzerNode(analyser);
    currentAudioSourceRef.current = source;

    if (emotionTimeline && emotionTimeline.length > 0) {
      setEmotionTimeline(emotionTimeline, audioBuffer.duration);
    }

    return new Promise((resolve) => {
      source.onended = () => {
        currentAudioSourceRef.current = null;
        setAnalyzerNode(null);
        clearLipsyncNode();
        clearEmotionTimeline();
        resolve();
      };
      source.start();
      setStatus('speaking');
    });
  }

  // ── Streaming TTS playback ──
  // Fetches /api/tts-stream, receives raw PCM16 chunks, and schedules them
  // as AudioBufferSourceNodes through the analyser + lipsync chain.
  // Playback starts on the first chunk (~200-500ms TTFB) while the rest streams in.
  async function playStreamingAudio(text, emotionTimeline = null) {
    if (!playbackContextRef.current || playbackContextRef.current.state === 'closed') {
      playbackContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
    }
    const ctx = playbackContextRef.current;
    await ctx.resume();

    const t0 = performance.now();

    // Set up the audio graph: analyser → delay → destination, + lipsync branch
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;

    const delayNode = ctx.createDelay(0.1);
    delayNode.delayTime.value = 0.05; // 50ms look-ahead for lip sync

    analyser.connect(delayNode);
    delayNode.connect(ctx.destination);

    let lipsyncNode = null;
    try {
      if (!lipsyncProfileRef.current) {
        lipsyncProfileRef.current = await fetch('/profile.json').then(r => r.json());
      }
      if (lipsyncNodeRef.current) {
        try { lipsyncNodeRef.current.disconnect(); } catch (_) {}
      }
      lipsyncNode = await createWLipSyncNode(ctx, lipsyncProfileRef.current);
      lipsyncNodeRef.current = lipsyncNode;
      setLipsyncNode(lipsyncNode);
    } catch (err) {
      console.warn('[wLipSync] Streaming: failed to create node:', err);
    }

    setAnalyzerNode(analyser);
    setStatus('speaking');

    // Fetch the streaming TTS endpoint
    const resp = await fetch('/api/tts-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!resp.ok) {
      console.error('[TTS-STREAM] HTTP error:', resp.status);
      setStatus('idle');
      throw new Error(`TTS stream failed: ${resp.status}`);
    }

    const sampleRate = parseInt(resp.headers.get('X-Sample-Rate') || '24000', 10);
    const reader = resp.body.getReader();

    // Scheduling state
    const CHUNK_SAMPLES = Math.floor(sampleRate * 0.25); // 250ms scheduling chunks
    const CHUNK_BYTES = CHUNK_SAMPLES * 2; // 16-bit = 2 bytes per sample
    let pendingBytes = new Uint8Array(0);
    let nextTime = ctx.currentTime + 0.08; // small initial buffer (80ms)
    let firstChunkLogged = false;
    let lastSource = null;
    let totalSamples = 0;

    // Helper: schedule a PCM chunk as an AudioBufferSourceNode
    function scheduleChunk(int16Data) {
      const audioBuffer = ctx.createBuffer(1, int16Data.length, sampleRate);
      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < int16Data.length; i++) {
        channelData[i] = int16Data[i] / 32768.0;
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      // Connect to shared analyser (which feeds delay → destination)
      source.connect(analyser);
      // Also connect to lipsync node if available
      if (lipsyncNode) source.connect(lipsyncNode);

      source.start(nextTime);
      nextTime += audioBuffer.duration;
      totalSamples += int16Data.length;
      lastSource = source;

      if (!firstChunkLogged) {
        firstChunkLogged = true;
        console.log(`[TTS-STREAM] First audio chunk playing at ${Math.round(performance.now() - t0)}ms TTFB`);
      }
    }

    // Read stream and schedule chunks
    while (true) {
      const { done, value } = await reader.read();

      if (value) {
        // Append new bytes to pending buffer
        const merged = new Uint8Array(pendingBytes.length + value.length);
        merged.set(pendingBytes);
        merged.set(value, pendingBytes.length);
        pendingBytes = merged;

        // Schedule complete 250ms chunks
        while (pendingBytes.length >= CHUNK_BYTES) {
          const chunkBytes = pendingBytes.slice(0, CHUNK_BYTES);
          pendingBytes = pendingBytes.slice(CHUNK_BYTES);
          const int16 = new Int16Array(chunkBytes.buffer, chunkBytes.byteOffset, chunkBytes.length / 2);
          scheduleChunk(int16);
        }
      }

      if (done) break;
    }

    // Schedule remaining samples
    if (pendingBytes.length >= 2) {
      const remaining = new Int16Array(
        pendingBytes.buffer, pendingBytes.byteOffset,
        Math.floor(pendingBytes.length / 2)
      );
      if (remaining.length > 0) scheduleChunk(remaining);
    }

    const totalDuration = totalSamples / sampleRate;
    console.log(`[TTS-STREAM] All chunks scheduled: ${totalSamples} samples (${totalDuration.toFixed(1)}s) in ${Math.round(performance.now() - t0)}ms`);

    // Set emotion timeline now that we know total duration
    if (emotionTimeline && emotionTimeline.length > 0) {
      setEmotionTimeline(emotionTimeline, totalDuration);
    }

    // Store a reference so stop works
    currentAudioSourceRef.current = lastSource;

    // Wait for the last scheduled chunk to finish playing
    return new Promise((resolve) => {
      if (!lastSource) {
        setAnalyzerNode(null);
        clearLipsyncNode();
        clearEmotionTimeline();
        setStatus('idle');
        resolve();
        return;
      }
      lastSource.onended = () => {
        currentAudioSourceRef.current = null;
        setAnalyzerNode(null);
        clearLipsyncNode();
        clearEmotionTimeline();
        resolve();
      };
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
        setCurrentEmotion(data.emotion);
        postLog({ type: 'turn', role: 'ai', text: data.response });
        await playStreamingAudio(data.response, data.emotionTimeline);
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
        // Read mic selection fresh from store (not stale closure)
        const micId = useAIStore.getState().selectedMicId;
        const audioConstraints = micId
          ? { deviceId: { exact: micId } }
          : true;
        const ms = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        rawMicStreamRef.current = ms;
        microphoneTrackRef.current = ms.getTracks()[0];

        // Set up mic volume analyser for real-time volume meter in UI
        try {
          const micCtx = new (window.AudioContext || window.webkitAudioContext)();
          micAudioCtxRef.current = micCtx;
          const micSource = micCtx.createMediaStreamSource(ms);
          const micAnalyser = micCtx.createAnalyser();
          micAnalyser.fftSize = 256;
          micAnalyser.smoothingTimeConstant = 0.3;
          micSource.connect(micAnalyser);
          // Don't connect to destination — we only need to read levels, not play back
          setMicAnalyser(micAnalyser);
        } catch (err) {
          console.warn('[MicMeter] Failed to create analyser:', err);
        }

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
        conversationStartRef.current = null; // Set later at step 10 when conversation actually begins
        pendingEndAfterTurnRef.current = false;
        endReasonRef.current = null;
        pendingDirectivesRef.current = [];

        // 5. Initialize ConversationManager (5-phase system)
        const { minMs, maxMs } = getDurations(unitData._book || 'ID1', unitData._chapter || 1);
        const chapterNumber = unitData._cumulative?.chapterNumber || unitData._chapter || 1;

        // Phase data from server-side compilation
        const phase2Data = unitData._cumulative?.phase2 || { topics: [], communicativeFunctions: [], newRules: [], modelSentences: [] };
        const phase3Data = unitData._cumulative?.phase3 || { topics: [], communicativeFunctions: [], newRules: [], modelSentences: [] };
        const phase4Enabled = unitData._cumulative?.phase4?.enabled || false;

        managerRef.current = new ConversationManager({
          phase2: phase2Data,
          phase3: phase3Data,
          phase4Enabled,
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
          // Hard max: trigger AI farewell — session ends after AI says goodbye
          // Only fire sendPromptTurn if Phase 5 farewell isn't already queued in pendingDirectives
          if (mgr.maxReached && !pendingEndAfterTurnRef.current) {
            pendingEndAfterTurnRef.current = true;
            endReasonRef.current = 'Maximum conversation time reached';
            clearInterval(conversationTimerRef.current);
            // Check if a Phase 5 farewell directive is already pending (from processAITurn)
            const farewellAlreadyQueued = pendingDirectivesRef.current.some(d => d.includes('Phase 5') || d.includes('farewell') || d.includes('say goodbye'));
            if (!farewellAlreadyQueued) {
              // Trigger a closing turn via directive — must include an actual goodbye word
              sendPromptTurn([
                '[SYSTEM: Maximum conversation time reached. You MUST say goodbye NOW. Say exactly one farewell sentence that includes "Tschüss" or "Auf Wiedersehen". Example: "Es war toll, mit dir zu reden! Tschüss, Niko!" Do NOT ask any questions. Do NOT continue the conversation. Just say goodbye.]',
              ]);
            }
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
        const { sessionId, response: aiGreeting, emotion: greetingEmotion, emotionTimeline: greetingTimeline } = await sessionResp.json();
        sessionIdRef.current = sessionId;

        // 8. Start log session (pass metadata for server-side transcript rescue)
        logSessionIdRef.current = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        {
          const storeSnap = useAIStore.getState();
          postLog({
            type: 'start',
            unit: unitData?.unit,
            unitTitle: unitData?._unitName
                    || (unitData?.conversation_topics?.topics || [])[0]
                    || '',
            accessCode: storeSnap.accessCode || '',
            accessType: storeSnap.accessType || '',
            assignedTo: storeSnap.assignedTo || '',
            studentName: studentName || '',
            book: unitData?._book || 'ID1',
            chapter: unitData?._chapter || 1,
          });
        }

        // 9. Add AI greeting to messages and process through manager
        addMessage('assistant', aiGreeting);
        setCurrentEmotion(greetingEmotion);
        postLog({ type: 'turn', role: 'ai', text: aiGreeting });
        checkBuddyAskedName(aiGreeting); // Track if buddy asked "Wie heißt du?"

        const mgr = managerRef.current;
        if (mgr) {
          const directives = mgr.processAITurn(aiGreeting);
          if (directives.length > 0) pendingDirectivesRef.current.push(...directives);
          // Skip topic classification during Phase 1 — warm-up doesn't count
        }

        // 10. Play greeting audio and go live
        const sessionStartTime = Date.now();
        conversationStartRef.current = sessionStartTime; // Same timestamp for both ref and store
        setSessionTiming(sessionStartTime, minMs, maxMs);
        setSessionActive(true);
        try {
          await playStreamingAudio(aiGreeting, greetingTimeline);
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
    const unitBook = unitDataRef.current?._book || 'ID1';
    const { minMs: minDurationMs } = getDurations(unitBook, unitDataRef.current?._chapter || 1);
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
      ? `Unit ${unitDataRef.current.unit} — ${unitDataRef.current._unitName || (unitDataRef.current.conversation_topics?.topics || [])[0] || ''}`
      : '';
    const durationMin = conversationStartRef.current
      ? Math.round((Date.now() - conversationStartRef.current) / 60000 * 10) / 10
      : 0;

    const endReason = endReasonRef.current || 'User ended conversation';
    endReasonRef.current = null;
    postLog({ type: 'end', endReason });

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

    // Clean up mic volume analyser
    setMicAnalyser(null);
    if (micAudioCtxRef.current) {
      micAudioCtxRef.current.close().catch(() => {});
      micAudioCtxRef.current = null;
    }

    setAnalyzerNode(null);
    if (lipsyncNodeRef.current) {
      try { lipsyncNodeRef.current.disconnect(); } catch (_) {}
      lipsyncNodeRef.current = null;
    }
    clearLipsyncNode();
    setSessionActive(false);
    setStatus("idle");

    // Async feedback — send results back to server for transcript enrichment
    if (unitNumber && utterancesSnapshot.length > 0) {
      fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ utterances: utterancesSnapshot, unit: unitNumber, book: unitBook, sessionDurationMs, minDurationMs, sessionId: endSessionId }),
      })
        .then(r => r.json())
        .then(data => {
          setFeedback(data);
          // Send feedback results to server so transcript can be updated
          if (data.fallback) {
            postLog({ type: 'feedback', fallback: true, reason: 'Session too short for feedback' });
          } else if (data.items) {
            postLog({ type: 'feedback', items: data.items });
          }
        })
        .catch(() => {
          setFeedback({ fallback: true });
          postLog({ type: 'feedback', fallback: true, reason: 'Feedback generation failed' });
        });
    } else {
      setFeedback({ fallback: true });
      postLog({ type: 'feedback', fallback: true, reason: utterancesSnapshot.length === 0 ? 'No student utterances' : 'No unit data' });
    }
    // Save transcript for download before clearing
    const msgs = useAIStore.getState().messages;
    const unitLabel = unitDataRef.current
      ? `Unit ${unitDataRef.current.unit} — ${unitDataRef.current._unitName || (unitDataRef.current.conversation_topics?.topics || [])[0] || ''}`
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
      // Detect best supported audio format — Safari doesn't support WebM
      let mimeType;
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        mimeType = 'audio/webm;codecs=opus';
      } else if (MediaRecorder.isTypeSupported('audio/webm')) {
        mimeType = 'audio/webm';
      } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        mimeType = 'audio/mp4';
      } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
        mimeType = 'audio/ogg;codecs=opus';
      } else {
        mimeType = ''; // let browser choose default
      }
      const mrOptions = mimeType ? { mimeType } : {};
      const mr = new MediaRecorder(stream, mrOptions);
      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.start(100);
      mediaRecorderRef.current = mr;
      console.log(`[Recording] MediaRecorder using: ${mr.mimeType}`);
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

    // Stop MediaRecorder and assemble blob with correct MIME type
    const actualMime = mr?.mimeType || 'audio/webm';
    const audioBlob = await new Promise((resolve) => {
      if (!mr || mr.state === 'inactive') {
        resolve(new Blob(audioChunksRef.current, { type: actualMime }));
        return;
      }
      mr.onstop = () => {
        resolve(new Blob(audioChunksRef.current, { type: actualMime }));
      };
      mr.stop();
    });

    // Map MIME type to correct file extension for Whisper
    const extMap = { 'audio/webm': '.webm', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/mpeg': '.mp3' };
    const ext = extMap[actualMime.split(';')[0]] || '.webm';

    try {
      // Build form data
      const fd = new FormData();
      fd.append('audio', audioBlob, `audio${ext}`);
      fd.append('sessionId', sessionIdRef.current);

      // Flush pending directives
      const directives = pendingDirectivesRef.current.splice(0);
      if (directives.length > 0) {
        fd.append('directives', JSON.stringify(directives));
      }

      const resp = await fetch('/api/conversation-turn', { method: 'POST', body: fd });
      if (!resp.ok) throw new Error(`Pipeline failed: ${resp.status}`);
      const { transcript, response: aiText, emotion: turnEmotion, emotionTimeline: turnTimeline } = await resp.json();

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
            if (!endReasonRef.current) endReasonRef.current = 'Student said goodbye';
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
      setCurrentEmotion(turnEmotion);
      postLog({ type: 'turn', role: 'ai', text: aiText });
      checkBuddyAskedName(aiText); // Track if buddy asked "Wie heißt du?"

      // ConversationManager processing
      const mgr = managerRef.current;
      if (mgr && aiText) {
        // Phase 4: detect if student asked a question (question mark or German question words)
        // Phase 4: count how many questions the student asked (supports multiple in one turn)
        if (mgr.getPhase() === 4 && cleaned !== '(inaudible)') {
          // Count question marks
          const qMarkCount = (cleaned.match(/\?/g) || []).length;
          if (qMarkCount > 0) {
            for (let i = 0; i < qMarkCount; i++) mgr.markPhase4Question();
          } else {
            // No question marks but might be a spoken question (German question words)
            const isQuestion = /\b(was|wer|wie|wo|woher|wohin|wann|warum|welch|hast du|bist du|magst du|kannst du|willst du)\b/i.test(cleaned);
            if (isQuestion) mgr.markPhase4Question();
          }
        }

        mgr.addAIUtterance(aiText); // Track questions the buddy has asked
        const mgrDirectives = mgr.processAITurn(aiText);
        if (mgrDirectives.length > 0) pendingDirectivesRef.current.push(...mgrDirectives);

        // Only classify topics during Phase 2+ (Phase 1 warm-up doesn't count)
        if (mgr.getPhase() >= 2) {
          const { currentTopics: ct, reviewTopics: rt } = mgr.getTopicsForClassification();
          if (ct.length > 0 || rt.length > 0) {
            console.log(`%c  🔍 Classifying AI text against ${ct.length} topics (Phase ${mgr.getPhase()})…`, 'color: #A78BFA;');
            fetch('/api/classify-topic', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: aiText, currentTopics: ct, reviewTopics: rt }),
            }).then(r => r.json()).then(result => {
              console.log(`%c  🔍 Classification result: ${JSON.stringify(result.matchedTopics || [])}`, 'color: #A78BFA;');
              const bd = mgr.updateTopicClassification(result);
              if (bd.length > 0) pendingDirectivesRef.current.push(...bd);
            }).catch((err) => {
              console.warn('[Classification] Failed:', err);
            });
          }
        }
      }

      // Post debug snapshot for expanded transcript
      {
        const mgr2 = managerRef.current;
        const snapshot = mgr2 ? mgr2.getDebugSnapshot() : {};
        const pendingDirs = pendingDirectivesRef.current.slice(); // copy current pending
        postLog({
          type: 'debug',
          turnIndex: exchangeCountRef.current,
          directives: directives, // directives sent WITH this turn
          pendingDirectives: pendingDirs, // directives queued for NEXT turn
          managerState: snapshot,
        });
      }

      // Play AI audio with streaming TTS
      await playStreamingAudio(aiText, turnTimeline);
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
      postLog({ type: 'error', error: err.message || String(err), context: 'conversation-turn-frontend' });
      setStatus('idle');
      setMicError('Something went wrong. Try again.');
    }
  }, [setStatus, setMicError, addMessage]);

  // ── Switch mic mid-session ──
  const switchMic = useCallback(async (deviceId) => {
    // Only relevant if we have an active mic stream
    if (!rawMicStreamRef.current) return;

    try {
      // Stop old mic tracks
      rawMicStreamRef.current.getTracks().forEach(t => t.stop());

      // Acquire new stream with selected device
      const audioConstraints = deviceId
        ? { deviceId: { exact: deviceId } }
        : true;
      const ms = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      rawMicStreamRef.current = ms;
      microphoneTrackRef.current = ms.getTracks()[0];

      // Rebuild mic volume analyser
      if (micAudioCtxRef.current) {
        micAudioCtxRef.current.close().catch(() => {});
      }
      const micCtx = new (window.AudioContext || window.webkitAudioContext)();
      micAudioCtxRef.current = micCtx;
      const micSource = micCtx.createMediaStreamSource(ms);
      const micAnalyser = micCtx.createAnalyser();
      micAnalyser.fftSize = 256;
      micAnalyser.smoothingTimeConstant = 0.3;
      micSource.connect(micAnalyser);
      setMicAnalyser(micAnalyser);

      console.log('[Mic] Switched to:', microphoneTrackRef.current.label || deviceId || 'default');
    } catch (err) {
      console.error('[Mic] Failed to switch:', err);
      setMicError('Could not switch microphone');
    }
  }, [setMicAnalyser, setMicError]);

  // ── Abandoned-session rescue via sendBeacon on page unload ──
  useEffect(() => {
    const handleBeforeUnload = () => {
      const logId = logSessionIdRef.current;
      if (!logId) return; // No active session
      const blob = new Blob(
        [JSON.stringify({ type: 'abandon', sessionId: logId, reason: 'browser_closed' })],
        { type: 'application/json' }
      );
      navigator.sendBeacon('/api/log', blob);
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  return {
    startConversation,
    endConversation,
    startRecording,
    stopRecording,
    isRecordingRef,
    switchMic,
  };
}
