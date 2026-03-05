import { useRef, useCallback } from "react";
import useAIStore from "../store/useAIStore";
import { generateUnitInstructions } from "../utils/systemInstructions";

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

  // postLog is stored in a ref so useCallback closures never go stale
  const postLogRef = useRef(null);
  postLogRef.current = (payload) => {
    if (!logSessionIdRef.current) return;
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, sessionId: logSessionIdRef.current }),
    }).catch(() => {});
  };
  function postLog(payload) { postLogRef.current?.(payload); }

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
          // Post a placeholder student row IMMEDIATELY so it appears before
          // the next AI response in the log. Whisper transcription arrives late
          // (after the AI response events), so we update this row once it arrives.
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

        // Built-in Realtime transcription — update the placeholder posted above.
        case 'conversation.item.input_audio_transcription.completed': {
          const raw = event.transcript?.trim();
          const cleaned = cleanTranscript(raw);
          const turnId = pendingStudentTurnIdRef.current;
          pendingStudentTurnIdRef.current = null;
          const finalText = cleaned || '(inaudible)';
          if (turnId) {
            postLog({ type: 'update-turn', id: turnId, text: finalText });
          } else {
            // Fallback: no pending id (e.g. reconnected mid-session)
            postLog({ type: 'turn', role: 'student', text: finalText });
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
          // Log AI turn
          if (event.transcript?.trim()) {
            postLog({ type: 'turn', role: 'ai', text: event.transcript.trim() });
          }
          break;

        case "response.done":
          prepareNewAIMessage();
          // Keep status as "speaking" until audio truly finishes.
          // Poll the analyzer: only go idle after 1500ms of continuous near-silence.
          // MAX_WAIT 30s covers long AI responses.
          (function waitForSilence() {
            clearTimeout(silenceTimerRef.current);
            const analyzer = analyzerRef.current;
            if (!analyzer) { setStatus("idle"); return; }
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
    async (unitData) => {
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
        dc.addEventListener("open", () => {
          const systemInstructions = generateUnitInstructions(unitData);

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
              temperature: 0.8,
              max_response_output_tokens: 300,
            },
          });

          // Seed an opening turn so the AI always speaks first
          sendRealtimeEvent({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "[Session started. Greet the student warmly in German and ask a simple open-ended question about the unit topic to begin the conversation. Speak only in German.]" }],
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
    // Log session end
    postLog({ type: 'end' });
    logSessionIdRef.current = null;

    clearTimeout(inaudibleTimerRef.current);
    clearTimeout(committedTimeoutRef.current);
    committedTimeoutRef.current = null;
    isRecordingRef.current = false;
    waitingForResponseRef.current = false;
    pendingStudentTurnIdRef.current = null;
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
    clearMessages();
  }, [setSessionActive, setStatus, clearMessages, setAnalyzerNode]);

  const startRecording = useCallback(() => {
    const track = microphoneTrackRef.current;
    if (!track) { console.warn('[Recording] startRecording: no mic track'); return; }
    isRecordingRef.current = true;
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
