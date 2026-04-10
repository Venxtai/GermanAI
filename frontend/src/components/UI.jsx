import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import useAIStore from "../store/useAIStore";
import { useVoiceConnection } from "../hooks/useVoiceConnection";
import { getDurations } from "../utils/systemInstructions";

const BUILD_VERSION = (() => {
  try {
    const d = new Date(__BUILD_TIME__);
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    const pad = n => String(n).padStart(2, '0');
    return `v2.6.0 · ${mon} ${d.getDate()}, ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return 'v2.6.0'; }
})();

const STATUS_LABELS = {
  idle: "Ready",
  listening: "Listening\u2026",
  speaking: "Speaking\u2026",
  loading: "Thinking\u2026",
};

const BOOK_COLORS = {
  ID1:  "#008899",
  ID2B: "#00528a",
  ID2O: "#ed6c28",
};

// Convert hex color to rgba for cross-browser compatibility
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Mic device selector — lets students pick their microphone.
 */
function MicSelector({ bookColor, onSwitch }) {
  const { selectedMicId, setSelectedMicId } = useAIStore();
  const [devices, setDevices] = useState([]);

  // Enumerate audio input devices on mount and when permissions change
  useEffect(() => {
    async function loadDevices() {
      try {
        // Need a temporary stream to get labeled devices (browsers hide labels until permission granted)
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = allDevices.filter(d => d.kind === 'audioinput');
        setDevices(audioInputs);
        // Stop temp stream tracks
        tempStream.getTracks().forEach(t => t.stop());
      } catch (err) {
        console.warn('[MicSelector] Could not enumerate devices:', err);
      }
    }
    loadDevices();
    // Re-enumerate when devices change (plug/unplug)
    navigator.mediaDevices.addEventListener('devicechange', loadDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', loadDevices);
  }, []);

  if (devices.length <= 1) return null; // No need to show selector if only one mic

  return (
    <select
      value={selectedMicId || ''}
      onChange={(e) => {
        const newId = e.target.value || null;
        setSelectedMicId(newId);
        if (onSwitch) onSwitch(newId);
      }}
      style={{
        width: '100%',
        background: 'rgba(255,255,255,0.08)',
        border: '1px solid rgba(255,255,255,0.15)',
        color: 'rgba(255,255,255,0.8)',
        fontSize: '11px',
        borderRadius: '8px',
        padding: '5px 8px',
        outline: 'none',
        cursor: 'pointer',
      }}
    >
      <option value="" style={{ background: '#1a1a2e' }}>Default microphone</option>
      {devices.map(d => (
        <option key={d.deviceId} value={d.deviceId} style={{ background: '#1a1a2e' }}>
          {d.label || `Microphone ${d.deviceId.slice(0, 8)}`}
        </option>
      ))}
    </select>
  );
}

/**
 * Real-time mic volume meter — shows students if they're speaking loudly enough.
 * Grey = too quiet, bookColor = good level.
 */
function MicVolumeMeter({ bookColor, analyser }) {
  const barRef = useRef(null);
  const rafRef = useRef(null);
  const dataRef = useRef(null);

  useEffect(() => {
    if (!analyser) return;

    const update = () => {
      if (!dataRef.current || dataRef.current.length !== analyser.frequencyBinCount) {
        dataRef.current = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(dataRef.current);
      const data = dataRef.current;
      // Focus on speech frequencies (200-4000 Hz)
      const sampleRate = analyser.context?.sampleRate || 48000;
      const hzPerBin = sampleRate / (analyser.fftSize || 256);
      const lo = Math.max(1, Math.floor(200 / hzPerBin));
      const hi = Math.min(data.length - 1, Math.ceil(4000 / hzPerBin));
      let sum = 0;
      for (let i = lo; i <= hi; i++) sum += data[i];
      const level = sum / ((hi - lo + 1) * 255); // 0-1

      if (barRef.current) {
        const pct = Math.min(level * 3, 1); // amplify so normal speech fills bar
        const loud = level > 0.08; // threshold for "loud enough"
        barRef.current.style.width = `${Math.max(pct * 100, 2)}%`;
        barRef.current.style.background = loud ? bookColor : 'rgba(255,255,255,0.25)';
      }

      rafRef.current = requestAnimationFrame(update);
    };
    rafRef.current = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rafRef.current);
  }, [analyser, bookColor]);

  return (
    <div
      style={{
        width: '100%',
        height: 4,
        borderRadius: 2,
        background: 'rgba(255,255,255,0.08)',
        overflow: 'hidden',
      }}
    >
      <div
        ref={barRef}
        style={{
          height: '100%',
          borderRadius: 2,
          width: '2%',
          background: 'rgba(255,255,255,0.25)',
          transition: 'background 0.15s',
        }}
      />
    </div>
  );
}

// Progress bar — fills based on maxMs, dotted line at minMs
function ProgressBar({ bookColor }) {
  const { conversationStartTime, sessionMinMs, sessionMaxMs, status } = useAIStore();
  const [progress, setProgress] = useState(0);

  const targetMs = sessionMaxMs; // bar fills to 100% at max duration
  const minThreshold = targetMs > 0 ? sessionMinMs / targetMs : 0; // dotted line at min duration

  // Only update progress when buddy finishes speaking (status changes FROM 'speaking' to something else)
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (!conversationStartTime || targetMs <= 0) return;
    const wasSpeaking = prevStatusRef.current === 'speaking';
    prevStatusRef.current = status;
    if (wasSpeaking && status !== 'speaking') {
      const elapsed = Date.now() - conversationStartTime;
      setProgress(Math.min(1, elapsed / targetMs));
    }
  }, [status, conversationStartTime, targetMs]);

  if (!conversationStartTime) return null;

  return (
    <div className="w-full relative" style={{ height: "14px" }}>
      <div className="absolute inset-0 rounded-full" style={{ background: "rgba(255,255,255,0.1)" }} />
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
        style={{ width: `${progress * 100}%`, background: bookColor || "#008899", opacity: 0.85 }}
      />
      {minThreshold > 0 && minThreshold < 1 && (
        <div
          className="absolute top-0 bottom-0"
          style={{
            left: `${minThreshold * 100}%`,
            width: "2px",
            borderLeft: "2px dotted rgba(255,255,255,0.5)",
          }}
        />
      )}
    </div>
  );
}

const BOOKS = [
  { id: "ID1",  label: "Impuls Deutsch 1" },
  { id: "ID2B", label: "Impuls Deutsch 2 BLAU" },
  { id: "ID2O", label: "Impuls Deutsch 2 ORANGE" },
];

const CHAPTERS_BY_BOOK = {
  ID1: [
    { chapter: 1, title: "Wer bin ich?: Heute und in der Zukunft",                                         unitStart: 1,  unitEnd: 15  },
    { chapter: 2, title: "Was ziehe ich an?: Wetter und Klimawandel",                                       unitStart: 16, unitEnd: 26  },
    { chapter: 3, title: "Was ist da drin? Lebensmittel unter der Lupe",                                    unitStart: 27, unitEnd: 37  },
    { chapter: 4, title: "Wie gestalte ich mein Leben?: \u201eSchlanke Produktion\u201c f\u00fcr Haus und Alltag", unitStart: 38, unitEnd: 52  },
    { chapter: 5, title: "Woher kommen meine Sachen?: Konsum, Verpackungen, M\u00fclltrennung",             unitStart: 53, unitEnd: 67  },
    { chapter: 6, title: "Wie war es damals?: Kindheit im Wandel der Zeit",                                 unitStart: 68, unitEnd: 79  },
    { chapter: 7, title: "Was gibt\u2019s da zu sehen?: Sehensw\u00fcrdigkeiten in Wien",                   unitStart: 80, unitEnd: 93  },
    { chapter: 8, title: "Wie sieht die Zukunft aus?: Erfindungen und Innovationen",                        unitStart: 94, unitEnd: 104 },
  ],
  ID2B: [
    { chapter: 1, title: "Wie leben wir nachhaltig?: Kommunikation f\u00fcr die Zukunft unseres Planeten", unitStart: 1,  unitEnd: 14 },
    { chapter: 2, title: "Was war da los?: Ost-West-Geschichte(n)",                                        unitStart: 15, unitEnd: 26 },
    { chapter: 3, title: "Wer sind wir?: Deutsch im Plural",                                               unitStart: 27, unitEnd: 37 },
    { chapter: 4, title: "Wie unterhalten wir uns?: Alte und neue Medien",                                 unitStart: 38, unitEnd: 52 },
  ],
  ID2O: [
    { chapter: 1, title: "Wer w\u00fcrde sich trauen?: Achterbahnen und anderer Nervenkitzel",             unitStart: 1,  unitEnd: 17 },
    { chapter: 2, title: "Wof\u00fcr/wogegen sind wir?: Protest, Widerstand, Mitbestimmung",              unitStart: 18, unitEnd: 29 },
    { chapter: 3, title: "Wie wird das gemacht?: Die Schweiz als Herstellerin von Qualit\u00e4tsprodukten", unitStart: 30, unitEnd: 41 },
    { chapter: 4, title: "Was pr\u00e4gt uns?: Transatlantische Beziehungen und Einfl\u00fcsse",              unitStart: 42, unitEnd: 52 },
  ],
};

const WELCOME_TEXT = `Welcome to the Impuls Deutsch Conversation Buddy! Here are a few tips before we start. Speak only in German during the conversation. If you don't understand something, say "Wie bitte?" or "Noch einmal, bitte." Answer the buddy's questions, but also ask your own questions! A progress bar will show how much conversation time remains before you receive feedback. The buddy is in a prototype testing mode that requires extensive note-taking after every turn. Don't be surprised if the buddy takes a moment between turns. When you're ready, click the button below to begin.`;

function WelcomeScreen({ onBack, onStart, bookColor, prefetchedBuffer }) {
  const [audioReady, setAudioReady] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const audioContextRef = useRef(null);
  const audioSourceRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function playBuffer(buffer) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = ctx;
      await ctx.resume();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      audioSourceRef.current = source;
      source.onended = () => { setAudioPlaying(false); setAudioReady(true); };
      source.start();
      setAudioPlaying(true);
    }

    async function fetchAndPlay() {
      try {
        const resp = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: '__WELCOME__', voice: 'Schedar', language: 'en-US' }),
        });
        const data = await resp.json();
        if (cancelled || !data.audioBase64) { setAudioReady(true); return; }
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        audioContextRef.current = ctx;
        await ctx.resume();
        const binaryStr = atob(data.audioBase64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
        if (cancelled) return;
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        audioSourceRef.current = source;
        source.onended = () => { setAudioPlaying(false); setAudioReady(true); };
        source.start();
        setAudioPlaying(true);
      } catch {
        if (!cancelled) setAudioReady(true);
      }
    }

    // If pre-decoded buffer is ready, play instantly. Otherwise fetch.
    if (prefetchedBuffer) {
      playBuffer(prefetchedBuffer);
    } else {
      fetchAndPlay();
    }

    return () => {
      cancelled = true;
      if (audioSourceRef.current) try { audioSourceRef.current.stop(); } catch (_) {}
      if (audioContextRef.current) audioContextRef.current.close().catch(() => {});
    };
  }, [prefetchedBuffer]);

  const buttonDisabled = !audioReady;
  // Safety timeout: if TTS+playback takes too long, enable button anyway (60s)
  useEffect(() => {
    const t = setTimeout(() => setAudioReady(true), 60000);
    return () => clearTimeout(t);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ paddingLeft: "50%" }}
      className="pointer-events-auto absolute inset-0 flex items-center justify-start"
    >
      <div className="backdrop-blur-md rounded-2xl p-8 w-[500px] flex flex-col gap-5" style={{ background: "rgba(0,0,0,0.7)", border: "1px solid rgba(255,255,255,0.08)" }}>
        <button
          onClick={onBack}
          className="text-xs self-start transition-colors"
          style={{ color: "rgba(255,255,255,0.5)" }}
          onMouseEnter={e => e.currentTarget.style.color = "rgba(255,255,255,1)"}
          onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.5)"}
        >
          &larr; Back
        </button>
        <div className="text-center">
          <h1 className="text-xl font-bold" style={{ color: bookColor || '#fff' }}>Impuls Deutsch</h1>
          <p className="text-white text-xl">Conversation Buddy</p>
        </div>
        <ul className="flex flex-col gap-3 text-sm" style={{ color: "rgba(255,255,255,0.8)", padding: "0 0.5rem" }}>
          <li className="flex gap-2"><span className="shrink-0" style={{ color: "rgba(255,255,255,0.4)" }}>&bull;</span>Speak only in German during the conversation.</li>
          <li className="flex gap-2"><span className="shrink-0" style={{ color: "rgba(255,255,255,0.4)" }}>&bull;</span><span>If you don&apos;t understand something, say<br/><span className="text-white font-bold">&quot;Wie bitte?&quot;</span> &nbsp;or&nbsp; <span className="text-white font-bold">&quot;Noch einmal, bitte.&quot;</span></span></li>
          <li className="flex gap-2"><span className="shrink-0" style={{ color: "rgba(255,255,255,0.4)" }}>&bull;</span>Answer the buddy&apos;s questions, but also ask your own questions!</li>
          <li className="flex gap-2"><span className="shrink-0" style={{ color: "rgba(255,255,255,0.4)" }}>&bull;</span>A progress bar will show how much conversation time remains before you receive feedback.</li>
          <li className="flex gap-2"><span className="shrink-0" style={{ color: "rgba(255,255,255,0.4)" }}>&bull;</span>The buddy is in a prototype testing mode that requires extensive note-taking after every turn. Don&apos;t be surprised if the buddy takes a moment between turns.</li>
        </ul>
        <p className="text-xs text-center" style={{ color: "rgba(255,255,255,0.5)" }}>
          {audioPlaying ? 'Listening to instructions...' : 'When you\'re ready, click the button below to begin.'}
        </p>
        <button
          onClick={onStart}
          disabled={buttonDisabled}
          className="font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2 text-white"
          style={{
            background: buttonDisabled
              ? hexToRgba(bookColor || '#008899', 0.3)
              : (bookColor || '#008899'),
            border: buttonDisabled
              ? '1px solid ' + hexToRgba(bookColor || '#008899', 0.5)
              : '1px solid transparent',
            cursor: buttonDisabled ? 'not-allowed' : 'pointer',
            opacity: buttonDisabled ? 0.7 : 1,
          }}
          onMouseEnter={e => { if (!buttonDisabled) e.currentTarget.style.brightness = '1.1'; e.currentTarget.style.opacity = '0.85'; }}
          onMouseLeave={e => { if (!buttonDisabled) e.currentTarget.style.opacity = '1'; }}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
          Start Conversation
        </button>
      </div>
      {/* Hidden skip button — tiny dot in lower left */}
      <div
        onClick={() => {
          if (audioSourceRef.current) try { audioSourceRef.current.stop(); } catch (_) {}
          if (audioContextRef.current) audioContextRef.current.close().catch(() => {});
          onStart();
        }}
        style={{
          position: 'fixed', bottom: '8px', left: '8px',
          width: '6px', height: '6px', borderRadius: '50%',
          background: 'rgba(255,255,255,0.3)', cursor: 'default',
          zIndex: 9999, pointerEvents: 'auto',
        }}
      />
    </motion.div>
  );
}

export function UI() {
  const [screen, setScreen] = useState("code");
  const [accessCode, setAccessCode] = useState("");
  const [accessInfo, setAccessInfo] = useState(null); // { type, remainingUses, assignedTo }
  const [studentName, setStudentName] = useState("");
  const [selectedBook, setSelectedBook] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [units, setUnits] = useState([]);
  const [selectedChapter, setSelectedChapter] = useState(null);
  const [pendingUnit, setPendingUnit] = useState(null);
  const [error, setError] = useState(null);
  const [endConfirm, setEndConfirm] = useState(null); // { remainingMin } or null
  const holdTimerRef = useRef(null);
  const isHoldingRef = useRef(false);

  // Prefetch AND pre-decode static welcome audio on page load
  const welcomeBufferRef = useRef(null);
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch('/audio/welcome_instructions.wav');
        const arrayBuffer = await resp.arrayBuffer();
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        await ctx.close();
        welcomeBufferRef.current = audioBuffer;
      } catch (e) {
        console.warn('[UI] Welcome audio prefetch failed:', e.message);
      }
    })();
  }, []);

  const { status, isSessionActive, micError, setMicError, feedback, setFeedback, transcriptForDownload, micAnalyser } = useAIStore();

  useEffect(() => {
    if (!micError) return;
    const t = setTimeout(() => setMicError(null), 4000);
    return () => clearTimeout(t);
  }, [micError, setMicError]);

  const { startConversation, endConversation, startRecording, stopRecording, isRecordingRef, switchMic } =
    useVoiceConnection();

  const wasSessionActiveRef = useRef(false);
  useEffect(() => {
    if (wasSessionActiveRef.current && !isSessionActive) {
      setScreen("feedback");
    }
    wasSessionActiveRef.current = isSessionActive;
  }, [isSessionActive]);

  const handleCodeSubmit = async () => {
    const code = accessCode.trim();
    if (!code) return;
    setError(null);
    try {
      console.log('[UI] Validating code:', code);
      const resp = await fetch('/api/auth/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await resp.json();
      console.log('[UI] Validate response:', data);
      if (!data.valid) {
        setError(data.error || 'Invalid access code');
        return;
      }
      setAccessInfo(data);
      // Store access code and assignedTo in Zustand for session logging
      const store = useAIStore.getState();
      store.setAccessCode(accessCode.trim());
      store.setAccessType(data.type || '');
      store.setAssignedTo(data.assignedTo || '');
      // Route: preselected codes go to name → preselect confirm; free codes go to name → book/chapter/unit
      setScreen("name");
    } catch (err) {
      console.error('[UI] Validate error:', err);
      setError("Could not verify code. Is the server running?");
    }
  };

  const handleNameSubmit = () => {
    if (!studentName.trim()) return;
    // If this code has a preselected unit, skip book/chapter/unit selection
    if (accessInfo?.preselectedUnit) {
      setScreen("preselect");
    } else {
      setScreen("book");
    }
  };

  // Handler for the preselected unit confirmation screen
  const handlePreselectedConfirm = async () => {
    const pre = accessInfo?.preselectedUnit;
    if (!pre) return;
    setError(null);
    try {
      // Confirm usage (increments the Used counter + logs)
      const confirmResp = await fetch('/api/auth/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: accessCode.trim() }),
      });
      const confirmData = await confirmResp.json();
      if (!confirmData.ok) {
        setError(confirmData.error || 'Could not confirm code');
        return;
      }

      // Load the unit data and go to welcome screen
      const fullUnit = await fetch(
        `/api/cumulative/${pre.unitId}?book=${pre.book}`
      ).then((r) => r.json());
      fullUnit._book = pre.book;
      fullUnit._chapter = pre.chapter;
      fullUnit._unitName = '';
      // Set selected book/chapter for session logging
      setSelectedBook(BOOKS.find(b => b.id === pre.book) || BOOKS[0]);
      setSelectedChapter({ chapter: pre.chapter, title: pre.chapterTitle });
      setPendingUnit(fullUnit);
      setScreen("welcome");
    } catch {
      setError("Failed to load unit data. Is the server running?");
    }
  };

  const handlePreselectedBack = () => {
    setScreen("code");
    setAccessCode("");
    setAccessInfo(null);
  };

  const handleBookSelect = (book) => {
    setSelectedBook(book);
    setChapters(CHAPTERS_BY_BOOK[book.id] || []);
    setError(null);
    setScreen("chapter");
  };

  const handleChapterSelect = async (ch) => {
    setSelectedChapter(ch);
    setError(null);
    try {
      const list = await fetch(`/api/units?book=${selectedBook?.id || 'ID1'}&chapter=${ch.chapter}`).then((r) => r.json());
      setUnits(list);
      setScreen("unit");
    } catch {
      setError("Failed to load units.");
    }
  };

  const handleUnitSelect = async (unitInfo) => {
    setError(null);
    try {
      const book = selectedBook?.id || 'ID1';
      const chapter = selectedChapter?.chapter || 1;
      const fullUnit = await fetch(
        `/api/cumulative/${unitInfo.unit}?book=${book}`
      ).then((r) => r.json());
      fullUnit._book = book;
      fullUnit._chapter = chapter;
      fullUnit._unitName = unitInfo.topic || '';
      setPendingUnit(fullUnit);
      setScreen("welcome");
    } catch {
      setError("Failed to load unit data. Is the server running?");
    }
  };

  const handleStartSession = async () => {
    if (!pendingUnit) return;
    setScreen("session");
    try {
      await startConversation(pendingUnit, studentName.trim());
    } catch {
      setError("Failed to connect. Is the server running?");
      setScreen("unit");
    }
  };

  const handleFeedbackDone = () => {
    setFeedback(null);
    setScreen("code");
    setAccessCode("");
    setAccessInfo(null);
    setStudentName("");
    setSelectedBook(null);
    setSelectedChapter(null);
    setUnits([]);
    setPendingUnit(null);
  };

  // ══════════════════════════════════════════════════════════════
  //  CALIBRATION MODE
  // ══════════════════════════════════════════════════════════════
  const CALIB_SENTENCES = [
    { text: "Max, bist du da?", emotion: "curious" },
    { text: "Peter mag den Park.", emotion: "happy" },
    { text: "Oh, das ist traurig.", emotion: "empathetic" },
    { text: "schön, Schule, ich, Bach", emotion: "excited" },
    { text: "über, Öl, gut, so", emotion: "thinking" },
    { text: "eins, Haus, Europa", emotion: "neutral" },
  ];
  const CALIB_EMOTIONS = ["happy", "excited", "curious", "empathetic", "thinking", "concerned"];

  const { calibrationMode, calibrationPhase, calibrationAnalysis, calibrationFeedback } = useAIStore();
  const calibRunningRef = useRef(false);

  const startCalibration = async () => {
    const store = useAIStore.getState();
    store.enterCalibration();
    setScreen("calibration");
    calibRunningRef.current = true;

    // Brief pause to let UI transition
    await new Promise(r => setTimeout(r, 500));

    // ── Phase 1: Play test sentences ──
    store.setCalibrationPhase('sentences');
    store.clearCalibrationFrameLog();

    for (let i = 0; i < CALIB_SENTENCES.length; i++) {
      if (!calibRunningRef.current) break;
      store.setCalibrationSentenceIndex(i);

      // Set emotion for this sentence BEFORE playback starts
      store.setCurrentEmotion(CALIB_SENTENCES[i].emotion);

      try {
        // Get TTS audio from server (German voice)
        const resp = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: CALIB_SENTENCES[i].text, voice: 'Achernar', language: 'de-DE' }),
        });
        const { audioBase64, mimeType } = await resp.json();

        // Play through the real audio pipeline (triggers wLipSync + analyser)
        if (!playbackContextRef.current || playbackContextRef.current.state === 'closed') {
          playbackContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
        }
        const ctx = playbackContextRef.current;
        await ctx.resume();

        const binaryStr = atob(audioBase64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let j = 0; j < binaryStr.length; j++) bytes[j] = binaryStr.charCodeAt(j);
        const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;

        // wLipSync node
        try {
          const { createWLipSyncNode } = await import('wlipsync');
          if (!window._calibLipsyncProfile) {
            window._calibLipsyncProfile = await fetch('/profile.json').then(r => r.json());
          }
          const lipsyncNode = await createWLipSyncNode(ctx, window._calibLipsyncProfile);
          const delayNode = ctx.createDelay(0.1);
          delayNode.delayTime.value = 0.05;
          source.connect(analyser);
          analyser.connect(delayNode);
          delayNode.connect(ctx.destination);
          source.connect(lipsyncNode);
          useAIStore.getState().setAnalyzerNode(analyser);
          useAIStore.getState().setLipsyncNode(lipsyncNode);
        } catch {
          source.connect(analyser);
          analyser.connect(ctx.destination);
          useAIStore.getState().setAnalyzerNode(analyser);
        }

        useAIStore.getState().setStatus('speaking');
        await new Promise(resolve => {
          source.onended = () => {
            useAIStore.getState().setStatus('idle');
            useAIStore.getState().setAnalyzerNode(null);
            useAIStore.getState().clearLipsyncNode();
            resolve();
          };
          source.start();
        });

        // 1s pause between sentences
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        console.error('[Calibration] TTS error for sentence', i, err);
      }
    }

    if (!calibRunningRef.current) return;

    // ── Phase 2: Cycle emotions ──
    store.setCalibrationPhase('emotions');
    for (let i = 0; i < CALIB_EMOTIONS.length; i++) {
      if (!calibRunningRef.current) break;
      store.setCalibrationEmotionIndex(i);
      store.setCurrentEmotion(CALIB_EMOTIONS[i]);
      await new Promise(r => setTimeout(r, 4000));
    }
    store.setCurrentEmotion('neutral');

    // ── Phase 3: Done — wait for user action ──
    store.setCalibrationPhase('done');
  };

  const runCalibrationAnalysis = async () => {
    const store = useAIStore.getState();
    store.setCalibrationPhase('analyzing');

    const frameLog = store.calibrationFrameLog;
    const userFeedback = store.calibrationFeedback;
    const currentTuning = store.calibrationTuning;

    try {
      const resp = await fetch('/api/calibrate/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frameLog, userFeedback, currentTuning }),
      });
      const result = await resp.json();
      if (result.tuning) {
        store.setCalibrationTuning(result.tuning);
      }
      store.setCalibrationAnalysis(result.analysis || 'No analysis returned.');
      store.setCalibrationPhase('done');
    } catch (err) {
      store.setCalibrationAnalysis('Analysis failed: ' + err.message);
      store.setCalibrationPhase('done');
    }
  };

  const runAgainWithImprovements = async () => {
    const store = useAIStore.getState();
    store.clearCalibrationFrameLog();
    store.setCalibrationAnalysis(null);
    store.setCalibrationPhase(null);
    store.setCalibrationSentenceIndex(-1);
    store.setCalibrationEmotionIndex(-1);

    // Re-run the full sequence with current tuning overrides already in store
    calibRunningRef.current = true;

    await new Promise(r => setTimeout(r, 300));
    const storeNow = useAIStore.getState();
    storeNow.setCalibrationPhase('sentences');
    storeNow.clearCalibrationFrameLog();

    // Log current tuning so user can verify changes are applied
    console.log('[Calibration] Running with tuning:', JSON.stringify(useAIStore.getState().calibrationTuning));

    for (let i = 0; i < CALIB_SENTENCES.length; i++) {
      if (!calibRunningRef.current) break;
      storeNow.setCalibrationSentenceIndex(i);
      storeNow.setCurrentEmotion(CALIB_SENTENCES[i].emotion);

      try {
        const resp = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: CALIB_SENTENCES[i].text, voice: 'Achernar', language: 'de-DE' }),
        });
        const { audioBase64, mimeType } = await resp.json();

        if (!playbackContextRef.current || playbackContextRef.current.state === 'closed') {
          playbackContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
        }
        const ctx = playbackContextRef.current;
        await ctx.resume();

        const binaryStr = atob(audioBase64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let j = 0; j < binaryStr.length; j++) bytes[j] = binaryStr.charCodeAt(j);
        const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;

        try {
          const { createWLipSyncNode } = await import('wlipsync');
          if (!window._calibLipsyncProfile) {
            window._calibLipsyncProfile = await fetch('/profile.json').then(r => r.json());
          }
          const lipsyncNode = await createWLipSyncNode(ctx, window._calibLipsyncProfile);
          const delayNode = ctx.createDelay(0.1);
          delayNode.delayTime.value = 0.05;
          source.connect(analyser);
          analyser.connect(delayNode);
          delayNode.connect(ctx.destination);
          source.connect(lipsyncNode);
          useAIStore.getState().setAnalyzerNode(analyser);
          useAIStore.getState().setLipsyncNode(lipsyncNode);
        } catch {
          source.connect(analyser);
          analyser.connect(ctx.destination);
          useAIStore.getState().setAnalyzerNode(analyser);
        }

        useAIStore.getState().setStatus('speaking');
        await new Promise(resolve => {
          source.onended = () => {
            useAIStore.getState().setStatus('idle');
            useAIStore.getState().setAnalyzerNode(null);
            useAIStore.getState().clearLipsyncNode();
            resolve();
          };
          source.start();
        });

        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        console.error('[Calibration] TTS error for sentence', i, err);
      }
    }

    if (!calibRunningRef.current) return;

    storeNow.setCalibrationPhase('emotions');
    for (let i = 0; i < CALIB_EMOTIONS.length; i++) {
      if (!calibRunningRef.current) break;
      storeNow.setCalibrationEmotionIndex(i);
      storeNow.setCurrentEmotion(CALIB_EMOTIONS[i]);
      await new Promise(r => setTimeout(r, 4000));
    }
    storeNow.setCurrentEmotion('neutral');
    storeNow.setCalibrationPhase('done');
  };

  const exitCalibration = () => {
    calibRunningRef.current = false;
    useAIStore.getState().exitCalibration();
    useAIStore.getState().setStatus('idle');
    useAIStore.getState().setCurrentEmotion('neutral');
    setScreen("code");
  };

  // Need a playback context ref for calibration audio
  const playbackContextRef = useRef(null);

  const handlePointerDown = () => {
    if (status !== "idle") return;
    isHoldingRef.current = true;
    holdTimerRef.current = setTimeout(() => {
      if (isHoldingRef.current) startRecording();
    }, 100);
  };

  const handlePointerUp = () => {
    isHoldingRef.current = false;
    clearTimeout(holdTimerRef.current);
    if (isRecordingRef.current) stopRecording();
  };

  const bookColor = selectedBook ? (BOOK_COLORS[selectedBook.id] || "#008899") : "#008899";

  return (
    <div className="fixed inset-0 pointer-events-none select-none">

      {/* Access code entry */}
      <AnimatePresence>
        {screen === "code" && (
          <>
            <motion.div
              initial="hidden" animate="visible" exit="hidden"
              variants={{
                hidden: { opacity: 0 },
                visible: { opacity: 1, transition: { delay: 4.5, duration: 0.8 } },
              }}
              transition={{ duration: 0.1 }}
              style={{ paddingLeft: "50%" }}
              className="pointer-events-auto absolute inset-0 flex items-center justify-start"
            >
              <div className="backdrop-blur-md rounded-2xl p-8 w-[420px] flex flex-col gap-4" style={{ background: "rgba(0,0,0,0.65)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <div className="text-center">
                  <h1 className="text-white text-xl font-bold">Impuls Deutsch</h1>
                  <p className="text-white text-xl">Conversation Buddy</p>
                </div>
                <p className="text-sm text-center leading-relaxed" style={{ color: "rgba(255,255,255,0.7)" }}>
                  Welcome! Please enter your access code to begin.
                </p>
                {error && <p className="text-red-400 text-sm text-center">{error}</p>}
                <div className="flex justify-center">
                  <input
                    type="text"
                    value={accessCode}
                    onChange={(e) => setAccessCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleCodeSubmit(); }}
                    placeholder="Access code (e.g. STU-A7X9)"
                    className="name-input px-4 py-3 rounded-xl text-white text-sm outline-none transition-colors text-center tracking-wider"
                    style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", letterSpacing: "0.1em", width: "90%" }}
                    onFocus={(e) => e.currentTarget.style.borderColor = "rgba(255,255,255,0.4)"}
                    onBlur={(e) => e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)"}
                  />
                </div>
                <button
                  onClick={handleCodeSubmit}
                  disabled={!accessCode.trim()}
                  className="disabled:opacity-30 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors"
                  style={{ background: "rgba(255,255,255,0.1)" }}
                  onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.background = "rgba(255,255,255,0.2)"; }}
                  onMouseLeave={e => { if (!e.currentTarget.disabled) e.currentTarget.style.background = "rgba(255,255,255,0.1)"; }}
                >
                  ENTER
                </button>
              </div>
            </motion.div>
            {/* Invite Students button — top-right, identical layout to End Session button (p-6 container + flex end) */}
            <motion.div
              initial="hidden" animate="visible" exit="hidden"
              variants={{
                hidden: { opacity: 0 },
                visible: { opacity: 1, transition: { delay: 4.5, duration: 0.8 } },
              }}
              transition={{ duration: 0.1 }}
              className="pointer-events-auto absolute inset-0 flex justify-end items-start p-6"
              style={{ pointerEvents: "none" }}
            >
              <button
                onClick={() => window.open('https://buddy.impulsdeutsch.com/invite', '_blank')}
                className="pointer-events-auto backdrop-blur-sm text-white text-xs font-medium px-4 py-2 rounded-full transition-colors"
                style={{ background: "rgba(237,108,40,0.8)" }}
                onMouseEnter={e => e.currentTarget.style.background = "rgba(237,108,40,1)"}
                onMouseLeave={e => e.currentTarget.style.background = "rgba(237,108,40,0.8)"}
              >Invite Students</button>
            </motion.div>
            {/* Hidden calibration dot — lower right (matching rules-skip dot style) */}
            <div
              onClick={() => {
                const pw = prompt('Password:');
                if (pw === 'Niko') startCalibration();
              }}
              style={{
                position: 'fixed', bottom: '8px', right: '8px',
                width: '6px', height: '6px', borderRadius: '50%',
                background: 'rgba(255,255,255,0.3)', cursor: 'default',
                zIndex: 9999, pointerEvents: 'auto',
              }}
            />
          </>
        )}
      </AnimatePresence>

      {/* ══════ Calibration Mode UI ══════ */}
      <AnimatePresence>
        {screen === "calibration" && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="pointer-events-auto absolute inset-0 flex flex-col justify-end items-end p-4"
            style={{ zIndex: 100 }}
          >
            <div className="backdrop-blur-md rounded-2xl p-5 w-[380px] flex flex-col gap-3" style={{ background: "rgba(0,0,0,0.80)", border: "1px solid rgba(255,255,255,0.1)" }}>
              <div className="flex justify-between items-center">
                <h2 className="text-white text-sm font-bold">Calibration Mode</h2>
                <button
                  onClick={exitCalibration}
                  className="text-xs px-3 py-1 rounded-full transition-colors"
                  style={{ background: "rgba(239,68,68,0.8)", color: "white" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(239,68,68,1)"}
                  onMouseLeave={e => e.currentTarget.style.background = "rgba(239,68,68,0.8)"}
                >Exit</button>
              </div>

              {/* Phase indicator */}
              <div className="text-xs" style={{ color: "rgba(255,255,255,0.6)" }}>
                {calibrationPhase === 'sentences' && 'Playing test sentences...'}
                {calibrationPhase === 'emotions' && 'Cycling emotions...'}
                {calibrationPhase === 'analyzing' && 'Claude is analyzing frame data...'}
                {calibrationPhase === 'done' && 'Sequence complete.'}
                {!calibrationPhase && 'Starting...'}
              </div>

              {/* Analysis result */}
              {calibrationAnalysis && (
                <div className="text-xs p-3 rounded-lg overflow-y-auto" style={{ background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.85)", maxHeight: "200px", whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: "10px", lineHeight: 1.5 }}>
                  {calibrationAnalysis}
                </div>
              )}

              {/* Tuning values display — show actual values so user can verify */}
              {useAIStore.getState().calibrationTuning && (
                <div className="text-xs p-2 rounded-lg" style={{ background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)" }}>
                  <div style={{ color: "rgba(100,255,100,0.9)", fontWeight: 700, marginBottom: "2px" }}>Active Tuning Overrides:</div>
                  <div style={{ color: "rgba(255,255,255,0.7)", fontFamily: "monospace", fontSize: "9px", lineHeight: 1.4 }}>
                    mult: {useAIStore.getState().calibrationTuning.globalMultiplier?.toFixed(2) || '—'}
                    {' | '}xfade: {useAIStore.getState().calibrationTuning.crossfadeSpeed?.toFixed(2) || '—'}
                    <br/>
                    {Object.entries(useAIStore.getState().calibrationTuning.visemeMaxWeight || {}).map(([k, v]) =>
                      `${k.replace('viseme_','')}: ${v.toFixed(2)}`
                    ).join(' | ')}
                  </div>
                </div>
              )}

              {/* User feedback input */}
              {calibrationPhase === 'done' && (
                <>
                  <textarea
                    placeholder="Your observations (e.g. 'mouth too wide on O', 'bilabials not closing enough')"
                    value={calibrationFeedback}
                    onChange={(e) => useAIStore.getState().setCalibrationFeedback(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg text-xs text-white outline-none resize-none"
                    style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", minHeight: "60px", fontFamily: "system-ui" }}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={runCalibrationAnalysis}
                      className="flex-1 text-xs font-medium py-2 rounded-lg transition-colors text-white"
                      style={{ background: "rgba(59,130,246,0.8)" }}
                      onMouseEnter={e => e.currentTarget.style.background = "rgba(59,130,246,1)"}
                      onMouseLeave={e => e.currentTarget.style.background = "rgba(59,130,246,0.8)"}
                    >Analyze & Suggest</button>
                    <button
                      onClick={runAgainWithImprovements}
                      className="flex-1 text-xs font-medium py-2 rounded-lg transition-colors text-white"
                      style={{ background: "rgba(34,197,94,0.8)" }}
                      onMouseEnter={e => e.currentTarget.style.background = "rgba(34,197,94,1)"}
                      onMouseLeave={e => e.currentTarget.style.background = "rgba(34,197,94,0.8)"}
                    >Run Again</button>
                  </div>
                  <button
                    onClick={() => {
                      const store = useAIStore.getState();
                      const tuning = store.calibrationTuning;
                      const frames = store.calibrationFrameLog;
                      const feedback = store.calibrationFeedback;
                      const analysis = store.calibrationAnalysis;

                      const lines = [];
                      lines.push('═'.repeat(70));
                      lines.push('CALIBRATION REPORT');
                      lines.push(`Generated: ${new Date().toISOString()}`);
                      lines.push('═'.repeat(70));
                      lines.push('');

                      lines.push('── USER OBSERVATIONS ──');
                      lines.push(feedback || '(none)');
                      lines.push('');

                      lines.push('── CLAUDE ANALYSIS ──');
                      lines.push(analysis || '(none)');
                      lines.push('');

                      lines.push('── RECOMMENDED TUNING VALUES ──');
                      lines.push('Apply these to Character.jsx VISEME_MAX_WEIGHT and constants:');
                      lines.push('');
                      if (tuning) {
                        lines.push(`globalMultiplier: ${tuning.globalMultiplier}`);
                        lines.push(`crossfadeSpeed: ${tuning.crossfadeSpeed}`);
                        lines.push('');
                        lines.push('VISEME_MAX_WEIGHT = {');
                        for (const [k, v] of Object.entries(tuning.visemeMaxWeight || {})) {
                          lines.push(`  ${k}: ${v.toFixed(2)},`);
                        }
                        lines.push('};');
                      } else {
                        lines.push('(no tuning changes — using defaults)');
                      }
                      lines.push('');

                      lines.push('── FRAME DATA SUMMARY ──');
                      lines.push(`Total speech frames captured: ${frames.length}`);
                      if (frames.length > 0) {
                        // Compute averages per viseme
                        const visemeKeys = ['v_PP','v_FF','v_DD','v_kk','v_CH','v_SS','v_nn','v_RR','v_aa','v_E','v_I','v_O','v_U'];
                        const bannedKeys = ['mouthPucker','mouthFunnel','mouthRollLower','tongueOut','mouthClose'];
                        lines.push('');
                        lines.push('Average viseme weights during speech:');
                        for (const k of visemeKeys) {
                          const avg = frames.reduce((sum, f) => sum + parseFloat(f[k] || 0), 0) / frames.length;
                          const max = Math.max(...frames.map(f => parseFloat(f[k] || 0)));
                          lines.push(`  ${k.replace('v_','viseme_').padEnd(12)}: avg=${avg.toFixed(3)}  max=${max.toFixed(3)}`);
                        }
                        lines.push('');
                        lines.push('Banned channel values (should all be 0):');
                        for (const k of bannedKeys) {
                          const max = Math.max(...frames.map(f => parseFloat(f[k] || 0)));
                          const violations = frames.filter(f => parseFloat(f[k] || 0) > 0.001).length;
                          lines.push(`  ${k.padEnd(18)}: max=${max.toFixed(3)}  violations=${violations}/${frames.length}`);
                        }
                        lines.push('');
                        lines.push('Emotions seen:');
                        const emotionCounts = {};
                        for (const f of frames) {
                          const e = f.emotion || f.activeEmotionTag || 'neutral';
                          emotionCounts[e] = (emotionCounts[e] || 0) + 1;
                        }
                        for (const [e, c] of Object.entries(emotionCounts)) {
                          lines.push(`  ${e}: ${c} frames`);
                        }
                      }
                      lines.push('');

                      lines.push('── RAW FRAME LOG (last 50) ──');
                      const tail = frames.slice(-50);
                      for (const f of tail) {
                        lines.push(JSON.stringify(f));
                      }
                      lines.push('');
                      lines.push('═'.repeat(70));
                      lines.push('END OF REPORT');
                      lines.push('Upload this file to Claude to apply the tuning changes to Character.jsx');
                      lines.push('═'.repeat(70));

                      const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `calibration-report-${Date.now()}.txt`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="w-full text-xs font-medium py-2 rounded-lg transition-colors text-white"
                    style={{ background: "rgba(168,85,247,0.8)" }}
                    onMouseEnter={e => e.currentTarget.style.background = "rgba(168,85,247,1)"}
                    onMouseLeave={e => e.currentTarget.style.background = "rgba(168,85,247,0.8)"}
                  >Create Report</button>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Name entry */}
      <AnimatePresence>
        {screen === "name" && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ paddingLeft: "50%" }}
            className="pointer-events-auto absolute inset-0 flex items-center justify-start"
          >
            <div className="backdrop-blur-md rounded-2xl p-8 w-[420px] flex flex-col gap-4" style={{ background: "rgba(0,0,0,0.65)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <div className="text-center">
                <h1 className="text-white text-xl font-bold">Impuls Deutsch</h1>
                <p className="text-white text-xl">Conversation Buddy</p>
              </div>
              {accessInfo?.remainingUses >= 0 && (
                <p className="text-xs text-center" style={{ color: "rgba(255,255,255,0.45)" }}>
                  {accessInfo.remainingUses} session{accessInfo.remainingUses !== 1 ? 's' : ''} remaining
                </p>
              )}
              <p className="text-sm text-center" style={{ color: "rgba(255,255,255,0.55)" }}>Please enter your name to start:</p>
              <div className="flex justify-center">
                <input
                  type="text"
                  value={studentName}
                  onChange={(e) => setStudentName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleNameSubmit(); }}
                  placeholder="Your name"
                  className="name-input px-4 py-3 rounded-xl text-white text-sm outline-none transition-colors"
                  style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", width: "90%" }}
                  onFocus={(e) => e.currentTarget.style.borderColor = "rgba(255,255,255,0.4)"}
                  onBlur={(e) => e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)"}
                />
              </div>
              <button
                onClick={handleNameSubmit}
                disabled={!studentName.trim()}
                className="disabled:opacity-30 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors"
                style={{ background: "rgba(255,255,255,0.1)" }}
                onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.background = "rgba(255,255,255,0.2)"; }}
                onMouseLeave={e => { if (!e.currentTarget.disabled) e.currentTarget.style.background = "rgba(255,255,255,0.1)"; }}
              >
                CONTINUE
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Preselected unit confirmation */}
      <AnimatePresence>
        {screen === "preselect" && accessInfo?.preselectedUnit && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ paddingLeft: "50%" }}
            className="pointer-events-auto absolute inset-0 flex items-center justify-start"
          >
            <div className="backdrop-blur-md rounded-2xl p-8 w-[420px] flex flex-col gap-5" style={{ background: "rgba(0,0,0,0.65)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <div className="text-center">
                <h1 className="text-white text-xl font-bold">Impuls Deutsch</h1>
                <p className="text-white text-xl">Conversation Buddy</p>
              </div>
              <div className="text-center">
                <p className="text-white/60 text-sm mb-3">Your teacher has assigned this conversation:</p>
                <hr style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.15)', margin: '0 0 12px 0' }} />
                <div className="rounded-xl p-4" style={{ background: "rgba(0,136,153,0.15)", border: "1px solid rgba(0,136,153,0.3)" }}>
                  <p className="text-white/70 text-xs mb-1">{accessInfo.preselectedUnit.bookLabel}</p>
                  <p className="text-white font-bold text-lg">Chapter {accessInfo.preselectedUnit.chapter}</p>
                  <p className="text-white/80 text-sm mt-1">{accessInfo.preselectedUnit.chapterTitle}</p>
                  {accessInfo.preselectedUnit.deadline && (
                    <p className="text-white/50 text-xs mt-2">Due: {accessInfo.preselectedUnit.deadline}</p>
                  )}
                </div>
              </div>
              {error && <p className="text-red-400 text-sm text-center">{error}</p>}
              <div className="flex gap-3 justify-center">
                <button
                  onClick={handlePreselectedBack}
                  className="px-5 py-2 rounded-lg text-white/70 hover:text-white transition"
                  style={{ background: "rgba(255,255,255,0.1)" }}
                >
                  ← Back
                </button>
                <button
                  onClick={handlePreselectedConfirm}
                  className="px-6 py-2 rounded-lg text-white font-semibold transition hover:brightness-110"
                  style={{ background: "#008899" }}
                >
                  OK — Start Conversation
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Book selection */}
      <AnimatePresence>
        {screen === "book" && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ paddingLeft: "50%" }}
            className="pointer-events-auto absolute inset-0 flex items-center justify-start"
          >
            <div className="backdrop-blur-md rounded-2xl p-8 w-[420px] flex flex-col gap-4" style={{ background: "rgba(0,0,0,0.65)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <div className="text-center">
                <h1 className="text-white text-xl font-bold">Impuls Deutsch</h1>
                <p className="text-white text-xl">Conversation Buddy</p>
              </div>
              <p className="text-sm text-center" style={{ color: "rgba(255,255,255,0.6)" }}>Please select your <span className="text-white font-bold">textbook</span></p>
              {BOOKS.map((book) => (
                <button
                  key={book.id}
                  onClick={() => handleBookSelect(book)}
                  style={{ background: BOOK_COLORS[book.id], border: "1px solid rgba(255,255,255,0.15)" }}
                  className="text-left rounded-xl px-5 py-4 transition-colors w-full hover:brightness-110"
                >
                  <p className="text-white text-sm font-medium">{book.label}</p>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chapter selection */}
      <AnimatePresence>
        {screen === "chapter" && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ paddingLeft: "50%" }}
            className="pointer-events-auto absolute inset-0 flex items-center justify-start"
          >
            <div className="backdrop-blur-md rounded-2xl p-8 w-[480px] max-h-[80vh] overflow-y-auto flex flex-col gap-4" style={{ background: "rgba(0,0,0,0.65)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <button
                onClick={() => { setScreen("book"); setError(null); }}
                className="text-xs self-start transition-colors"
                style={{ color: "rgba(255,255,255,0.5)" }}
                onMouseEnter={e => e.currentTarget.style.color = "rgba(255,255,255,1)"}
                onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.5)"}
              >
                ← Back
              </button>
              <div className="text-center">
                <h1 className="text-xl font-bold" style={{ color: bookColor }}>Impuls Deutsch</h1>
                <p className="text-white text-xl">Conversation Buddy</p>
              </div>
              <p className="text-sm text-center -mt-2" style={{ color: "rgba(255,255,255,0.55)" }}>Please select your <span className="text-white font-bold">current chapter</span> from {selectedBook?.label}.</p>
              {error && <p className="text-red-400 text-xs text-center">{error}</p>}
              {chapters.map((ch) => (
                <button
                  key={ch.chapter}
                  onClick={() => handleChapterSelect(ch)}
                  style={{ background: hexToRgba(bookColor, 0.3), border: "1px solid " + hexToRgba(bookColor, 0.5) }}
                  className="text-left rounded-xl px-5 py-3 transition-colors hover:brightness-125"
                >
                  <span className="text-xs font-mono" style={{ color: "rgba(255,255,255,0.5)" }}>Ch. {ch.chapter}</span>
                  <p className="text-white text-sm font-medium mt-0.5">{ch.title}</p>
                  {ch.unitStart && (
                    <p className="text-xs mt-0.5" style={{ color: "rgba(255,255,255,0.4)" }}>Units {ch.unitStart}–{ch.unitEnd}</p>
                  )}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Unit selection */}
      <AnimatePresence>
        {screen === "unit" && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ paddingLeft: "50%" }}
            className="pointer-events-auto absolute inset-0 flex items-center justify-start"
          >
            <div className="backdrop-blur-md rounded-2xl p-8 w-[480px] max-h-[80vh] overflow-y-auto flex flex-col gap-3" style={{ background: "rgba(0,0,0,0.65)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <button
                onClick={() => { setScreen("chapter"); }}
                className="text-xs self-start transition-colors"
                style={{ color: "rgba(255,255,255,0.5)" }}
                onMouseEnter={e => e.currentTarget.style.color = "rgba(255,255,255,1)"}
                onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.5)"}
              >
                ← Back
              </button>
              <div className="text-center">
                <h1 className="text-xl font-bold" style={{ color: bookColor }}>Impuls Deutsch</h1>
                <p className="text-white text-xl">Conversation Buddy</p>
              </div>
              <p className="text-sm text-center" style={{ color: "rgba(255,255,255,0.6)" }}>What is the <span className="text-white font-bold">last unit</span> from {selectedBook?.label} you covered in class?</p>
              {error && <p className="text-red-400 text-xs">{error}</p>}
              {units.map((u, idx) => {
                // Units 1-6 of Impuls Deutsch 1 are unavailable (no conversation content yet)
                const unitNum = parseInt(String(u.unit).replace(/^[BO]/i, ''), 10);
                const isUnavailable = selectedBook?.id === 'ID1' && !isNaN(unitNum) && unitNum >= 1 && unitNum <= 6;
                return (
                <button
                  key={u.unit}
                  onClick={() => { if (!isUnavailable) handleUnitSelect(u); }}
                  title={isUnavailable ? "No conversation available" : undefined}
                  className="text-left rounded-xl px-5 py-3 transition-colors flex items-center justify-between gap-4"
                  style={{
                    background: hexToRgba(bookColor, isUnavailable ? 0.15 : 0.3),
                    border: "1px solid " + hexToRgba(bookColor, isUnavailable ? 0.25 : 0.5),
                    opacity: isUnavailable ? 0.5 : 1,
                    cursor: isUnavailable ? "not-allowed" : "pointer",
                  }}
                  onMouseEnter={e => { if (!isUnavailable) e.currentTarget.style.background = hexToRgba(bookColor, 0.45); }}
                  onMouseLeave={e => { if (!isUnavailable) e.currentTarget.style.background = hexToRgba(bookColor, 0.3); }}
                >
                  <div>
                    <span className="text-white text-sm font-medium">Unit {String(u.unit).replace(/^[BO]/i, '')}</span>
                    {u.topic && <span className="text-sm" style={{ color: "rgba(255,255,255,0.5)" }}> — {u.topic}</span>}
                  </div>
                  {u.is_optional && (
                    <span className="text-xs shrink-0" style={{ color: "rgba(255,255,255,0.4)" }}>(Optional)</span>
                  )}
                </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Welcome screen with auto-read instructions */}
      <AnimatePresence>
        {screen === "welcome" && (
          <WelcomeScreen
            onBack={() => setScreen("unit")}
            onStart={handleStartSession}
            bookColor={bookColor}
            prefetchedBuffer={welcomeBufferRef.current}
          />
        )}
      </AnimatePresence>

      {/* Feedback screen */}
      <AnimatePresence>
        {screen === "feedback" && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ paddingLeft: "50%" }}
            className="pointer-events-auto absolute inset-0 flex items-center justify-start"
          >
            <div className="backdrop-blur-md rounded-2xl p-8 w-[500px] flex flex-col gap-5" style={{ background: "rgba(0,0,0,0.7)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <h2 className="text-white text-xl font-bold">Session Complete 🎉</h2>
              {feedback === 'loading' && (
                <div className="flex items-center gap-3 text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
                  <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Generating your feedback…
                </div>
              )}
              {feedback?.fallback && (
                <p className="text-sm" style={{ color: "rgba(255,255,255,0.7)" }}>The conversation was a bit short this time. Try a longer session to get detailed feedback on what you practiced!</p>
              )}
              {feedback?.items?.length > 0 && (
                <>
                  <p className="text-sm" style={{ color: "rgba(255,255,255,0.7)" }}>Here's what you practiced today:</p>
                  <ul className="flex flex-col gap-2">
                    {feedback.items.map((item, i) => (
                      <li key={i} className="flex gap-2 text-sm" style={{ color: "rgba(255,255,255,0.9)" }}><span className="text-green-400 shrink-0">✓</span>{item}</li>
                    ))}
                  </ul>
                </>
              )}
              {feedback !== 'loading' && transcriptForDownload && (
                <button
                  onClick={() => {
                    const t = transcriptForDownload;
                    const lines = [`Conversation Transcript`, `${t.unitLabel}`, `Date: ${t.date}`, `${'─'.repeat(50)}`, ''];
                    for (const msg of t.messages) {
                      const label = msg.role === 'user' ? 'STUDENT' : ' BUDDY';
                      lines.push(`${label}: ${msg.content}`);
                    }
                    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `transcript-${Date.now()}.txt`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="text-sm transition-colors"
                  style={{ color: "rgba(255,255,255,0.7)", textDecoration: "underline" }}
                  onMouseEnter={e => e.currentTarget.style.color = "rgba(255,255,255,1)"}
                  onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.7)"}
                >Download Transcript</button>
              )}
              {feedback !== 'loading' && (
                <button onClick={handleFeedbackDone} className="mt-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl transition-colors">Done</button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Connecting spinner */}
      <AnimatePresence>
        {screen === "session" && !isSessionActive && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 flex items-center justify-center" style={{ paddingLeft: "20%" }}>
            <div className="backdrop-blur-sm rounded-2xl px-8 py-5 flex flex-col items-center gap-3" style={{ background: "rgba(0,0,0,0.45)" }}>
              <div className="w-8 h-8 rounded-full animate-spin" style={{ borderWidth: "4px", borderStyle: "solid", borderColor: "rgba(255,255,255,0.3)", borderTopColor: "rgba(255,255,255,1)" }} />
              <p className="text-white text-sm font-medium">Connecting…</p>
              <button
                onClick={() => setScreen("unit")}
                className="pointer-events-auto text-xs transition-colors"
                style={{ color: "rgba(255,255,255,0.4)" }}
                onMouseEnter={e => e.currentTarget.style.color = "rgba(255,255,255,1)"}
                onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.4)"}
              >Cancel</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Active session UI */}
      <AnimatePresence>
        {isSessionActive && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none absolute inset-0 flex flex-col justify-between p-6">
            <div className="flex justify-between items-start">
              <div className="backdrop-blur-sm rounded-full px-4 py-2 flex items-center gap-2" style={{ background: "rgba(0,0,0,0.3)" }}>
                <div className={`w-2 h-2 rounded-full ${status === "listening" ? "bg-green-400 animate-pulse" : status === "speaking" ? "bg-blue-400 animate-pulse" : status === "loading" ? "bg-yellow-400 animate-pulse" : "bg-gray-400"}`} />
                <span className="text-white text-xs font-medium">{STATUS_LABELS[status] || "Ready"}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const { conversationStartTime, sessionMinMs } = useAIStore.getState();
                    const elapsed = conversationStartTime ? Date.now() - conversationStartTime : 0;
                    const feedbackMinMs = 0.6 * sessionMinMs; // must match server threshold
                    if (elapsed < feedbackMinMs) {
                      const remainingMin = Math.ceil((feedbackMinMs - elapsed) / 60000);
                      setEndConfirm({ remainingMin });
                    } else {
                      endConversation();
                    }
                  }}
                  className="pointer-events-auto backdrop-blur-sm text-white text-xs font-medium px-4 py-2 rounded-full transition-colors"
                  style={{ background: "rgba(239,68,68,0.8)" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(239,68,68,1)"}
                  onMouseLeave={e => e.currentTarget.style.background = "rgba(239,68,68,0.8)"}
                >End Session</button>
              </div>
            </div>
            <div className="flex justify-center" style={{ paddingLeft: "20%", paddingBottom: "6px" }}>
              <div style={{ width: "420px", display: "flex", flexDirection: "column", gap: "6px" }}>
                {/* Top box: Mic controls */}
                <div className="pointer-events-auto backdrop-blur-md rounded-2xl flex flex-col items-center gap-3" style={{ background: "rgba(0,0,0,0.65)", border: "1px solid rgba(255,255,255,0.08)", padding: "1.2rem 2.5rem 1.5rem" }}>
                  <AnimatePresence>
                    {micError && (
                      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} className="text-red-400 text-xs font-medium text-center max-w-[200px]">🎤 {micError}</motion.div>
                    )}
                  </AnimatePresence>
                  <p className="text-xs" style={{ color: "rgba(255,255,255,0.5)" }}>{status === "listening" ? "Release to send" : "Hold to speak"}</p>
                  <motion.button
                    onPointerDown={handlePointerDown} onPointerUp={handlePointerUp} onPointerLeave={handlePointerUp}
                    disabled={status === "speaking" || status === "loading"}
                    whileTap={{ scale: 0.92 }}
                    className={`w-16 h-16 rounded-full flex items-center justify-center shadow-2xl transition-colors border-4 ${status === "listening" ? "border-green-300 animate-pulse" : status === "speaking" || status === "loading" ? "border-gray-400 opacity-50 cursor-not-allowed" : "border-transparent hover:brightness-110"}`}
                    style={{
                      background: status === "listening" ? "#22c55e"
                        : status === "speaking" || status === "loading" ? "#6b7280"
                        : bookColor || "#008899",
                    }}
                  >
                    <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                  </motion.button>
                  {/* Volume meter — same width as progress bar */}
                  {micAnalyser && <div style={{ width: '100%' }}><MicVolumeMeter bookColor={bookColor} analyser={micAnalyser} /></div>}
                  {/* Mic device selector */}
                  <MicSelector bookColor={bookColor} onSwitch={switchMic} />
                </div>
                {/* Bottom box: Progress */}
                <div className="pointer-events-auto backdrop-blur-md rounded-2xl flex flex-col items-center gap-2" style={{ background: "rgba(0,0,0,0.65)", border: "1px solid rgba(255,255,255,0.08)", padding: "0.8rem 2.5rem 1rem" }}>
                  <p className="text-xs" style={{ color: "rgba(255,255,255,0.5)" }}>Progress</p>
                  <ProgressBar bookColor={bookColor} />
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* End session confirmation dialog */}
      <AnimatePresence>
        {endConfirm && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="pointer-events-auto absolute inset-0 flex items-center justify-center z-8"
            style={{ background: "rgba(0,0,0,0.4)" }}
          >
            <div className="backdrop-blur-md rounded-2xl p-8 w-[420px] flex flex-col gap-4" style={{ background: "rgba(0,0,0,0.8)", border: "1px solid rgba(255,255,255,0.1)" }}>
              <p className="text-white text-sm text-center leading-relaxed">
                The conversation is too short to receive feedback. You need about <span className="text-white font-bold">{endConfirm.remainingMin} more minute{endConfirm.remainingMin !== 1 ? 's' : ''}</span> to complete the session.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setEndConfirm(null)}
                  className="flex-1 text-white font-semibold py-3 rounded-xl transition-colors"
                  style={{ background: bookColor || "#008899" }}
                  onMouseEnter={e => e.currentTarget.style.opacity = "0.8"}
                  onMouseLeave={e => e.currentTarget.style.opacity = "1"}
                >Continue</button>
                <button
                  onClick={() => { setEndConfirm(null); endConversation(); }}
                  className="flex-1 text-white font-semibold py-3 rounded-xl transition-colors"
                  style={{ background: "rgba(239,68,68,0.8)" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(239,68,68,1)"}
                  onMouseLeave={e => e.currentTarget.style.background = "rgba(239,68,68,0.8)"}
                >End Anyway</button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {!["session", "feedback", "calibration"].includes(screen) && (
        <div style={{ position: 'fixed', bottom: 8, left: 0, right: 0, textAlign: 'center', fontSize: '11px', color: 'rgba(255,255,255,0.35)', pointerEvents: 'none', zIndex: 1 }}>
          {BUILD_VERSION}
        </div>
      )}
    </div>
  );
}
