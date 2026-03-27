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
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const audioElementRef = useRef(null);
  const microphoneTrackRef = useRef(null);
  const waitingForResponseRef = useRef(false);
  const lastTranscriptionIdRef = useRef(null);
  const lastVisualQuestionRef = useRef(null);
  const visualAnswerCheckedRef = useRef(false);
  const audioContextRef = useRef(null);
  const analyzerRef = useRef(null);       // mirror of analyzerNode for use in callbacks
  const silenceTimerRef = useRef(null);   // setTimeout id for silence detection
  const logSessionIdRef = useRef(null);   // correlates log entries on the backend
  const studentSpokeRef = useRef(false);  // true after stopRecording until transcript logged
  const recordStartRef = useRef(null);    // timestamp when recording started
  const inaudibleTimerRef = useRef(null); // delayed fallback if Whisper never delivers
  const mediaRecorderRef = useRef(null);  // captures mic audio for our own Whisper call
  const audioChunksRef = useRef([]);      // collected MediaRecorder chunks
  const rawMicStreamRef = useRef(null);   // the WebRTC getUserMedia stream (track is gated)
  const recMicStreamRef = useRef(null);   // SEPARATE stream for recording — never muted
  const isRecordingRef = useRef(false);   // true between startRecording() and stopRecording()
  const committedTimeoutRef = useRef(null); // safety-net if committed event never arrives
  const pendingStudentTurnIdRef = useRef(null); // id of the placeholder student row in the log
  const pendingAILogRef = useRef(null);        // AI transcript held until after student update-turn
  const logQueueRef = useRef(Promise.resolve()); // serializes POSTs so order is preserved
  const systemInstructionsRef = useRef(null);     // saved so we can patch them with the student's real name
  const studentNameRef = useRef(null);            // set once we detect the student's confirmed name
  const pendingNameCorrectionRef = useRef(null);  // correct name to self-inject when AI used wrong name
  const studentUtterancesRef = useRef([]);         // all Whisper transcripts this session (for feedback)
  const unitDataRef = useRef(null);               // unit data for current session
  const conversationStartRef = useRef(null);      // Date.now() when session opens
  const conversationTimerRef = useRef(null);      // setInterval that enforces min/max durations
  const silentStudentTimerRef = useRef(null);     // setTimeout — fires if student doesn't respond
  const exchangeCountRef = useRef(0);             // incremented on each Whisper transcript
  const topicsDiscussedRef = useRef(new Set());   // indices of unit topics covered so far
  const minDurationFiredRef = useRef(false);      // ensures min-duration event only fires once
  const maxDurationFiredRef = useRef(false);      // ensures max-duration event only fires once
  const pendingEndAfterTurnRef = useRef(false);   // auto-end after current AI turn finishes speaking
  const endConversationRef = useRef(null);        // ref to endConversation — avoids stale closures in callbacks
  const managerRef = useRef(null);                // ConversationManager instance for this session
  const typedNameRef = useRef(null);              // name entered on the welcome screen
  const nameConfirmationPendingRef = useRef(null); // {typed, spoken} when typed≠spoken, awaiting student confirmation

  // postLog is stored in a ref so useCallback closures never go stale.
  // All calls are chained on logQueueRef so each fetch completes before the next one
  // starts — this guarantees server-side broadcast order matches event order.
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
    updateLastAIMessage,
    finalizeAIMessage,
    prepareNewAIMessage,
    clearMessages,
    currentUnit,
    setAnalyzerNode,
    setMicError,
    setFeedback,
  } = useAIStore();

  const sendRealtimeEvent = useCallback((event) => {
    const dc = dataChannelRef.current;
    if (dc && dc.readyState === "open") {
      dc.send(JSON.stringify(event));
    }
  }, []);

  const handleRealtimeEvent = useCallback(
    (event) => {
      switch (event.type) {
        // After commit(), wait for this event before calling response.create.
        // Calling response.create in the same tick as commit() is a race condition
        // — the server hasn't finished ingesting the buffer yet.
        case 'input_audio_buffer.committed': {
          clearTimeout(committedTimeoutRef.current);
          committedTimeoutRef.current = null;
          console.log('[Realtime] input_audio_buffer.committed — waitingForResponse:', waitingForResponseRef.current);
          // If Whisper for the PREVIOUS turn never arrived and we already have
          // its AI response saved, flush it now before this new student placeholder
          // so the log stays in order across rapid exchanges.
          if (pendingAILogRef.current) {
            postLog({ type: 'turn', role: 'ai', text: pendingAILogRef.current });
            pendingAILogRef.current = null;
          }
          // Post a placeholder student row IMMEDIATELY so it appears before
          // the next AI response in the log.
          const turnId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
          pendingStudentTurnIdRef.current = turnId;
          postLog({ type: 'turn', role: 'student', text: '…', id: turnId, pending: true });
          if (waitingForResponseRef.current) {
            waitingForResponseRef.current = false;
            console.log('[Realtime] Sending response.create');
            sendRealtimeEvent({ type: 'response.create' });
          }
          break;
        }

        // Built-in Realtime transcription — update the placeholder, then post the
        // AI turn that was held in pendingAILogRef. Posting them together in the
        // serial queue guarantees student always precedes AI in the log viewer.
        case 'conversation.item.input_audio_transcription.completed': {
          const raw = event.transcript?.trim();
          const cleaned = cleanTranscript(raw);
          const turnId = pendingStudentTurnIdRef.current;
          pendingStudentTurnIdRef.current = null;
          const finalText = cleaned || '(inaudible)';
          if (cleaned) studentUtterancesRef.current.push(cleaned); // for post-session feedback

          // Farewell detection (spec 2.7) — check if student is saying goodbye
          if (cleaned) {
            const isFarewell = /\b(tsch[uü]ss|auf wiedersehen|tschau|ciao|bye|goodbye|auf wiederschauen|macht's gut|bis dann|bis später)\b/i.test(cleaned);
            if (isFarewell) {
              if (managerRef.current?.isMinDurationReached()) {
                // Min duration reached — allow the AI to say goodbye, then auto-end
                pendingEndAfterTurnRef.current = true;
                sendRealtimeEvent({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[SYSTEM: The student said goodbye and the minimum conversation time has been reached. Say your natural closing farewell NOW in one sentence, then the session will end automatically.]' }] } });
              } else {
                // Too early — AI must decline and continue
                sendRealtimeEvent({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[SYSTEM: The student tried to say goodbye but the minimum conversation time has NOT been reached. You MUST respond with the early-goodbye response (e.g. "Schon? Wir können noch ein bisschen reden!") and then continue the conversation.]' }] } });
              }
            }
          }

          // Increment exchange count for logging
          exchangeCountRef.current += 1;

          // Capture AI text now so we can compare it against the detected name below.
          const aiText = pendingAILogRef.current;
          pendingAILogRef.current = null;

          // ── Name confirmation flow ──
          // Step 1: If awaiting name confirmation (mismatch was detected), parse
          // the student's response for either name and finalize.
          if (nameConfirmationPendingRef.current && cleaned) {
            const { typed, spoken } = nameConfirmationPendingRef.current;
            nameConfirmationPendingRef.current = null;
            const mentionsTyped  = cleaned.toLowerCase().includes(typed.toLowerCase());
            const mentionsSpoken = cleaned.toLowerCase().includes(spoken.toLowerCase());
            const confirmedName  = mentionsSpoken && !mentionsTyped ? spoken
              : mentionsTyped ? typed
              : typed; // fallback
            studentNameRef.current = confirmedName;
            if (systemInstructionsRef.current) {
              sendRealtimeEvent({
                type: 'session.update',
                session: {
                  instructions:
                    `CRITICAL — The student's confirmed name is "${confirmedName}". ` +
                    `You MUST use ONLY this exact spelling for the rest of the session. ` +
                    `Never use any other name or spelling.\n\n` +
                    systemInstructionsRef.current,
                },
              });
            }
          }

          // Step 2: First time the student introduces themselves
          if (!studentNameRef.current && !nameConfirmationPendingRef.current && cleaned) {
            const nameMatch =
              cleaned.match(/ich hei[sß]e\s+([^\s.,!?]+)/i) ||
              cleaned.match(/mein name ist\s+([^\s.,!?]+)/i);
            if (nameMatch) {
              const spokenName = nameMatch[1];
              const typedName  = typedNameRef.current;
              if (typedName && spokenName.charAt(0).toLowerCase() !== typedName.charAt(0).toLowerCase()) {
                // Names start with different letters → genuinely different name → ask for clarification
                nameConfirmationPendingRef.current = { typed: typedName, spoken: spokenName };
                sendRealtimeEvent({
                  type: 'conversation.item.create',
                  item: { type: 'message', role: 'user', content: [{ type: 'input_text',
                    text: `[SYSTEM: The student typed "${typedName}" on the welcome screen but just said "${spokenName}". ` +
                      `You MUST ask for clarification in German: "Interessant. Dein Name ist nicht ${typedName}? ` +
                      `Heißt du ${typedName} oder heißt du ${spokenName}?" Then wait for the student to confirm.]` }] },
                });
              } else {
                // Same first letter or no typed name → use the typed spelling (handles Niko/Nico etc.)
                const finalName = typedName || spokenName;
                studentNameRef.current = finalName;
                if (systemInstructionsRef.current) {
                  sendRealtimeEvent({
                    type: 'session.update',
                    session: {
                      instructions:
                        `CRITICAL — The student's confirmed name is "${finalName}". ` +
                        `You MUST use ONLY this exact spelling for the rest of the session. ` +
                        `Never use any other name or spelling.\n\n` +
                        systemInstructionsRef.current,
                    },
                  });
                }
                if (aiText && !aiText.includes(finalName)) {
                  pendingNameCorrectionRef.current = finalName;
                }
              }
            }
          }
          if (turnId) {
            // update-turn first (student finalized), then AI — both in the
            // serial queue so order is guaranteed regardless of HTTP timing.
            postLog({ type: 'update-turn', id: turnId, text: finalText });
          } else {
            postLog({ type: 'turn', role: 'student', text: finalText });
          }
          if (aiText) {
            postLog({ type: 'turn', role: 'ai', text: aiText });
          }
          break;
        }

        case "input_audio_buffer.speech_started":
          console.log('[Realtime] speech_started (server VAD)');
          setStatus("listening");
          break;

        // NOTE: speech_stopped only fires with server VAD (turn_detection != null).
        // With turn_detection: null (manual push-to-talk) it never fires.
        // studentSpokeRef is armed in stopRecording() instead.

        case "response.audio_transcript.delta":
          updateLastAIMessage(event.delta);
          setStatus("speaking");
          break;

        case "response.audio_transcript.done":
          finalizeAIMessage(event.transcript);
          if (event.transcript?.trim()) {
            pendingAILogRef.current = event.transcript.trim();

            // Conversation Manager: process AI turn (phase transitions, timing, starters)
            const mgr = managerRef.current;
            if (mgr) {
              const directives = mgr.processAITurn(event.transcript.trim());
              for (const d of directives) {
                sendRealtimeEvent({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: d }] } });
              }
            }

            // Async semantic topic classification via GPT-4o-mini
            if (mgr) {
              const { currentTopics, reviewTopics } = mgr.getTopicsForClassification();
              if (currentTopics.length > 0 || reviewTopics.length > 0) {
                fetch('/api/classify-topic', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text: event.transcript.trim(), currentTopics, reviewTopics }),
                })
                  .then(r => r.json())
                  .then(result => {
                    const balanceDirectives = mgr.updateTopicClassification(result);
                    for (const d of balanceDirectives) {
                      sendRealtimeEvent({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: d }] } });
                    }
                  })
                  .catch(() => {});
              }
            }
          }
          break;

        case "response.done":
          prepareNewAIMessage();
          // Keep status as "speaking" until audio truly finishes.
          // Poll the analyzer: only go idle after 1500ms of continuous near-silence.
          // MAX_WAIT 30s covers long AI responses.
          (function waitForSilence() {
            clearTimeout(silenceTimerRef.current);
            clearTimeout(silentStudentTimerRef.current); // AI is speaking — cancel any pending student-silence prompt
            const analyzer = analyzerRef.current;
            if (!analyzer) {
              setStatus("idle");
              if (pendingEndAfterTurnRef.current) {
                pendingEndAfterTurnRef.current = false;
                endConversationRef.current?.();
                return;
              }
              const corrName = pendingNameCorrectionRef.current;
              if (corrName) {
                pendingNameCorrectionRef.current = null;
                sendRealtimeEvent({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `[SYSTEM: The speech-to-text transcription confirms the student's name is "${corrName}". Please immediately correct yourself naturally in German, e.g. "Oh, Entschuldigung — ${corrName}! Schön, dich kennenzulernen!"]` }] } });
                sendRealtimeEvent({ type: 'response.create' });
              } else {
                // Start student-silence timer — prompt if no mic press within 15s
                silentStudentTimerRef.current = setTimeout(() => {
                  if (!isRecordingRef.current && !waitingForResponseRef.current) {
                    sendRealtimeEvent({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[SYSTEM: The student has been silent for a while. Prompt them gently with a simple, encouraging question using vocabulary from the current unit.]' }] } });
                    sendRealtimeEvent({ type: 'response.create' });
                  }
                }, 60000);
              }
              return;
            }
            const buf = new Uint8Array(analyzer.frequencyBinCount);
            let silentMs = 0;
            const POLL_MS = 80;
            const SILENT_NEEDED = 1500; // must be quiet for 1.5s before going idle
            const MAX_WAIT = 30000;     // max 30s for very long responses
            let elapsed = 0;
            const poll = () => {
              analyzer.getByteFrequencyData(buf);
              const energy = buf.slice(2, 14).reduce((a, b) => a + b, 0) / 12;
              if (energy < 3) {
                silentMs += POLL_MS;
              } else {
                silentMs = 0; // reset on any audio activity
              }
              elapsed += POLL_MS;
              if (silentMs >= SILENT_NEEDED || elapsed >= MAX_WAIT) {
                setStatus("idle");
                if (pendingEndAfterTurnRef.current) {
                  pendingEndAfterTurnRef.current = false;
                  endConversationRef.current?.();
                  return;
                }
                // Name correction takes priority — fires its own response.create
                const corrName = pendingNameCorrectionRef.current;
                if (corrName) {
                  pendingNameCorrectionRef.current = null;
                  sendRealtimeEvent({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `[SYSTEM: The speech-to-text transcription confirms the student's name is "${corrName}". Please immediately correct yourself naturally in German, e.g. "Oh, Entschuldigung — ${corrName}! Schön, dich kennenzulernen!"]` }] } });
                  sendRealtimeEvent({ type: 'response.create' });
                } else {
                  // Start student-silence timer — prompt if no mic press within 15s
                  silentStudentTimerRef.current = setTimeout(() => {
                    if (!isRecordingRef.current && !waitingForResponseRef.current) {
                      sendRealtimeEvent({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[SYSTEM: The student has been silent for a while. Prompt them gently with a simple, encouraging question using vocabulary from the current unit.]' }] } });
                      sendRealtimeEvent({ type: 'response.create' });
                    }
                  }, 60000);
                }
              } else {
                silenceTimerRef.current = setTimeout(poll, POLL_MS);
              }
            };
            silenceTimerRef.current = setTimeout(poll, POLL_MS);
          })();
          break;

        case "error":
          console.error("[Realtime] API error:", event.error);
          // If we were waiting for a committed event, clear the safety-net timeout
          clearTimeout(committedTimeoutRef.current);
          committedTimeoutRef.current = null;
          waitingForResponseRef.current = false;
          setStatus("idle");
          break;

        default:
          break;
      }
    },
    [sendRealtimeEvent, setStatus, updateLastAIMessage, finalizeAIMessage, prepareNewAIMessage]
  );

  const startConversation = useCallback(
    async (unitData, studentName = '') => {
      setStatus("loading");
      clearMessages();

      try {
        // Get ephemeral token
        const tokenResponse = await fetch("/token");
        if (!tokenResponse.ok) throw new Error("Token request failed");
        const data = await tokenResponse.json();
        const EPHEMERAL_KEY = data.value;

        // Create peer connection
        const pc = new RTCPeerConnection();
        peerConnectionRef.current = pc;

        // Set up audio element for AI voice output
        const audioEl = document.createElement("audio");
        audioEl.autoplay = true;
        audioEl.volume = 1.0;
        audioElementRef.current = audioEl;

        pc.ontrack = (e) => {
          audioEl.srcObject = e.streams[0];

          // Set up AudioContext analyzer for lipsync.
          // Use createMediaStreamSource (not createMediaElementSource) so the
          // analyzer taps directly into the raw WebRTC stream — much more reliable.
          try {
            const audioCtx = new (window.AudioContext ||
              window.webkitAudioContext)();
            audioContextRef.current = audioCtx;
            audioCtx.resume().catch(() => {});

            // Direct stream source — audio element plays independently
            const streamSource = audioCtx.createMediaStreamSource(e.streams[0]);
            const analyzer = audioCtx.createAnalyser();
            analyzer.fftSize = 256;
            analyzer.smoothingTimeConstant = 0.5;
            streamSource.connect(analyzer);
            // NOTE: do NOT connect streamSource to destination — audioEl handles playback
            analyzerRef.current = analyzer;
            setAnalyzerNode(analyzer);
          } catch (err) {
            console.warn("AudioContext setup failed:", err);
          }
        };

        // Add microphone track — keep it ALWAYS enabled.
        // Using track.enabled = false to mute between turns silences the hardware
        // source on some browsers (Chrome), making even separate getUserMedia streams
        // record silence. Instead we gate via input_audio_buffer.clear/commit.
        const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
        rawMicStreamRef.current = ms;
        microphoneTrackRef.current = ms.getTracks()[0];
        // Do NOT disable the track — it must stay enabled at all times.
        pc.addTrack(microphoneTrackRef.current);

        // Log ICE / connection state changes to help debug audio path issues
        pc.oniceconnectionstatechange = () => {
          console.log('[WebRTC] ICE connection state:', pc.iceConnectionState);
        };
        pc.onconnectionstatechange = () => {
          console.log('[WebRTC] Connection state:', pc.connectionState);
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            console.warn('[WebRTC] Connection lost — mic audio may not reach OpenAI');
          }
        };

        // Create data channel
        const dc = pc.createDataChannel("oai-events");
        dataChannelRef.current = dc;

        // SDP exchange
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const baseUrl = "https://api.openai.com/v1/realtime";
        const model = "gpt-4o-realtime-preview-2024-12-17";

        const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${EPHEMERAL_KEY}`,
            "Content-Type": "application/sdp",
          },
        });

        if (!sdpResponse.ok)
          throw new Error(`SDP failed: ${sdpResponse.status}`);

        await pc.setRemoteDescription({
          type: "answer",
          sdp: await sdpResponse.text(),
        });

        // Wire up data channel events
        dc.addEventListener("open", async () => {
          // Fetch a freshly-generated persona for this chapter before building instructions
          let persona = null;
          try {
            const book = unitData._book || 'ID1';
            const chapter = unitData._chapter || 1;
            const pr = await fetch('/api/persona', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ book, chapter }),
            });
            if (pr.ok) {
              const pd = await pr.json();
              persona = pd.persona || null;
            }
          } catch (e) {
            console.warn('[Persona] Failed to fetch persona, using default:', e.message);
          }

          const systemInstructions = generateUnitInstructions(unitData, persona, studentName);
          systemInstructionsRef.current = systemInstructions;
          const buddyName = getBuddyFirstName(persona);
          studentNameRef.current = null;
          typedNameRef.current = studentName || null;
          nameConfirmationPendingRef.current = null;
          unitDataRef.current = unitData;
          exchangeCountRef.current = 0;
          topicsDiscussedRef.current = new Set();
          minDurationFiredRef.current = false;
          maxDurationFiredRef.current = false;
          conversationStartRef.current = Date.now();

          // ── Initialize Conversation Manager ──
          const { minMs: MIN_MS, maxMs: MAX_MS } = getDurations(
            unitData._book || 'ID1',
            unitData._chapter || 1
          );
          const currentTopics = unitData.conversation_topics?.topics || [];
          const reviewTopicData = unitData._cumulative?.reviewTopics || [];
          managerRef.current = new ConversationManager({
            currentTopics,
            reviewTopics: reviewTopicData,
            minMs: MIN_MS,
            maxMs: MAX_MS,
            studentNameKnown: !!studentName,
          });
          managerRef.current.start();

          // ── Timer: delegates to ConversationManager ──
          conversationTimerRef.current = setInterval(() => {
            const mgr = managerRef.current;
            if (!mgr) return;
            const directives = mgr.checkTiming();
            for (const d of directives) {
              sendRealtimeEvent({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: d }] } });
            }
            // Hard max: auto-end after AI delivers closing line
            if (mgr.maxReached && !pendingEndAfterTurnRef.current) {
              pendingEndAfterTurnRef.current = true;
              clearInterval(conversationTimerRef.current);
              if (!waitingForResponseRef.current && !isRecordingRef.current) {
                sendRealtimeEvent({ type: 'response.create' });
              }
            }
          }, 10000);

          // Start log session
          logSessionIdRef.current = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
          postLog({
            type: 'start',
            unit: unitData?.unit,
            unitTitle: (unitData?.communicative_functions?.goals || [])[0]
                    || (unitData?.conversation_topics?.topics || [])[0]
                    || '',
          });

          sendRealtimeEvent({
            type: "session.update",
            session: {
              modalities: ["text", "audio"],
              instructions: systemInstructions,
              voice: "verse",
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              // Re-enable built-in transcription so the AI can hear the audio.
              // We also run our own MediaRecorder path for the chat log.
              input_audio_transcription: {
                model: 'whisper-1',
                language: 'de',
              },
              turn_detection: null,
              temperature: 0.55,
              max_response_output_tokens: 300,
            },
          });

          // Seed an opening turn aligned with Phase 1 warm-up starters
          sendRealtimeEvent({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: studentName
                ? `[Session started. This is Phase 1 (warm-up). Your name is ${buddyName}. The student's name is "${studentName}". Do NOT ask "Wie heißt du?". Say: "Hallo, ${studentName}! Ich bin ${buddyName}." then ask: "Woher kommst du?" Do NOT ask about the unit topic yet. Speak only in German.]`
                : `[Session started. This is Phase 1 (warm-up). Your name is ${buddyName}. Say: "Hallo! Ich bin ${buddyName}." then ask the student: "Wie heißt du?" Do NOT ask about the unit topic yet. Speak only in German.]` }],
            },
          });
          sendRealtimeEvent({ type: "response.create" });
          setSessionActive(true);
          setStatus("idle");
        });

        dc.addEventListener("message", (e) => {
          handleRealtimeEvent(JSON.parse(e.data));
        });
      } catch (err) {
        console.error("Error starting conversation:", err);
        setStatus("idle");
        throw err;
      }
    },
    [
      currentUnit,
      sendRealtimeEvent,
      handleRealtimeEvent,
      setStatus,
      setSessionActive,
      clearMessages,
      setAnalyzerNode,
    ]
  );

  const endConversation = useCallback(() => {
    pendingEndAfterTurnRef.current = false; // clear in case end was triggered manually
    // Snapshot session data for feedback BEFORE any refs are cleared
    const utterancesSnapshot = [...studentUtterancesRef.current];
    const sessionDurationMs = conversationStartRef.current ? Date.now() - conversationStartRef.current : 0;
    const unitNumber = unitDataRef.current?.unit ?? null;
    const { minMs: minDurationMs } = getDurations(unitDataRef.current?._book || 'ID1', unitDataRef.current?._chapter || 1);
    studentUtterancesRef.current = [];
    setFeedback('loading');

    // Log session end
    postLog({ type: 'end' });
    logSessionIdRef.current = null;

    if (managerRef.current) {
      managerRef.current.reset();
      managerRef.current = null;
    }
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
    clearTimeout(inaudibleTimerRef.current);
    clearTimeout(committedTimeoutRef.current);
    committedTimeoutRef.current = null;
    isRecordingRef.current = false;
    waitingForResponseRef.current = false;
    pendingStudentTurnIdRef.current = null;
    // Flush any AI log entry that was held waiting for Whisper
    if (pendingAILogRef.current) {
      postLog({ type: 'turn', role: 'ai', text: pendingAILogRef.current });
      pendingAILogRef.current = null;
    }
    logQueueRef.current = Promise.resolve(); // reset queue for next session
    studentNameRef.current = null;
    systemInstructionsRef.current = null;
    pendingNameCorrectionRef.current = null;
    typedNameRef.current = null;
    nameConfirmationPendingRef.current = null;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    rawMicStreamRef.current = null;
    recMicStreamRef.current = null; // was removed; keeping ref null for safety

    if (dataChannelRef.current) dataChannelRef.current.close();
    if (peerConnectionRef.current) peerConnectionRef.current.close();
    if (audioElementRef.current) audioElementRef.current.srcObject = null;
    if (audioContextRef.current) audioContextRef.current.close();

    dataChannelRef.current = null;
    peerConnectionRef.current = null;
    audioElementRef.current = null;
    audioContextRef.current = null;
    microphoneTrackRef.current = null;

    setAnalyzerNode(null);
    setSessionActive(false);
    setStatus("idle");
    // Async: backend feedback generator; result updates the store when ready
    if (unitNumber && utterancesSnapshot.length > 0) {
      fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ utterances: utterancesSnapshot, unit: unitNumber, sessionDurationMs, minDurationMs }),
      })
        .then(r => r.json())
        .then(data => setFeedback(data))
        .catch(() => setFeedback({ fallback: true }));
    } else {
      setFeedback({ fallback: true });
    }
    clearMessages();
  }, [setSessionActive, setStatus, clearMessages, setAnalyzerNode, setFeedback]);
  // Keep ref in sync so handleRealtimeEvent closure can call it without going stale
  endConversationRef.current = endConversation;

  const startRecording = useCallback(() => {
    const track = microphoneTrackRef.current;
    if (!track) { console.warn('[Recording] startRecording: no mic track'); return; }
    isRecordingRef.current = true;
    clearTimeout(silentStudentTimerRef.current); // student pressed the mic — cancel silence prompt
    // Discard everything that accumulated in the buffer between turns.
    // The track is always enabled, so the buffer constantly fills with live audio.
    // clearing here means we only commit what the student says THIS press.
    console.log('[Recording] Starting — clearing buffer');
    sendRealtimeEvent({ type: 'input_audio_buffer.clear' });
    recordStartRef.current = Date.now();
    audioChunksRef.current = [];
    setMicError(null);

    // MediaRecorder from the same always-enabled stream — no gating issues.
    const stream = rawMicStreamRef.current;
    if (stream) {
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const mr = new MediaRecorder(stream, { mimeType });
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      mr.start(100);
      mediaRecorderRef.current = mr;
    }

    setStatus('listening');
  }, [sendRealtimeEvent, setStatus, setMicError]);

  const stopRecording = useCallback(() => {
    // Guard: only run if we are actually recording
    if (!isRecordingRef.current) {
      console.log('[Recording] stopRecording called but not recording — ignoring');
      return;
    }
    isRecordingRef.current = false;
    const track = microphoneTrackRef.current;
    if (!track) return;
    // Do NOT set track.enabled = false here — that's what was silencing the mic.
    clearTimeout(inaudibleTimerRef.current);

    const holdMs = Date.now() - (recordStartRef.current || 0);
    const mr = mediaRecorderRef.current;

    // Accidental tap — too short for Whisper.
    if (holdMs < 500) {
      if (mr && mr.state !== 'inactive') mr.stop();
      audioChunksRef.current = [];
      sendRealtimeEvent({ type: "input_audio_buffer.clear" });
      studentSpokeRef.current = false;
      setMicError("Hold the button while you speak, then release.");
      setStatus("idle");
      return;
    }

    // Commit the buffer and set the flag. response.create fires only after
    // the server confirms via input_audio_buffer.committed — no race condition.
    studentSpokeRef.current = true;
    waitingForResponseRef.current = true;
    console.log('[Recording] Committing buffer (holdMs:', holdMs, ')');
    sendRealtimeEvent({ type: 'input_audio_buffer.commit' });
    setStatus('loading');

    // Safety-net: if committed never arrives (e.g. empty buffer error from server),
    // reset state after 5s so the UI isn't stuck on "Thinking…" forever.
    committedTimeoutRef.current = setTimeout(() => {
      if (waitingForResponseRef.current) {
        console.warn('[Recording] committed event never arrived — resetting to idle');
        waitingForResponseRef.current = false;
        setStatus('idle');
        setMicError('Audio not captured. Make sure microphone access is allowed.');
      }
    }, 5000);

    // Stop the MediaRecorder — chunks used only for future reference/debug.
    if (mr && mr.state !== 'inactive') {
      mr.onstop = () => { audioChunksRef.current = []; studentSpokeRef.current = false; };
      mr.stop();
    } else {
      studentSpokeRef.current = false;
    }
  }, [sendRealtimeEvent, setStatus, setMicError]);

  return {
    startConversation,
    endConversation,
    startRecording,
    stopRecording,
    isRecordingRef,
  };
}
