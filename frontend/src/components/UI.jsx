import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import useAIStore from "../store/useAIStore";
import { useVoiceConnection } from "../hooks/useVoiceConnection";
import { getDurations } from "../utils/systemInstructions";

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

// Progress bar — fills based on midpoint of min/max, dotted line at min (feedback threshold)
function ProgressBar({ bookColor }) {
  const { conversationStartTime, sessionMinMs, sessionMaxMs, status } = useAIStore();
  const [progress, setProgress] = useState(0);

  const targetMs = (sessionMinMs + sessionMaxMs) / 2;
  const feedbackThreshold = targetMs > 0 ? sessionMinMs / targetMs : 0;

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
      {feedbackThreshold > 0 && feedbackThreshold < 1 && (
        <div
          className="absolute top-0 bottom-0"
          style={{
            left: `${feedbackThreshold * 100}%`,
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

const WELCOME_TEXT = `Welcome to the Impuls Deutsch Conversation Buddy! Here are a few tips before we start. Speak only in German during the conversation. If you don't understand something, say "Wie bitte?" or "Noch einmal, bitte." Answer the buddy's questions, but also ask your own questions! Pay attention to the buddy's answers — you may need them later. When you're ready, click the button below to begin.`;

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
          <li className="flex gap-2"><span className="shrink-0" style={{ color: "rgba(255,255,255,0.4)" }}>&bull;</span>Pay attention to the buddy&apos;s answers — you may need them later.</li>
          <li className="flex gap-2"><span className="shrink-0" style={{ color: "rgba(255,255,255,0.4)" }}>&bull;</span>A progress bar will show how much conversation time remains before you receive feedback.</li>
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

  const { status, isSessionActive, micError, setMicError, feedback, setFeedback, transcriptForDownload } = useAIStore();

  useEffect(() => {
    if (!micError) return;
    const t = setTimeout(() => setMicError(null), 4000);
    return () => clearTimeout(t);
  }, [micError, setMicError]);

  const { startConversation, endConversation, startRecording, stopRecording, isRecordingRef } =
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
      setScreen("name");
    } catch (err) {
      console.error('[UI] Validate error:', err);
      setError("Could not verify code. Is the server running?");
    }
  };

  const handleNameSubmit = () => {
    if (!studentName.trim()) return;
    setScreen("book");
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
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ delay: 4.5, duration: 0.8 }}
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
              {units.map((u) => (
                <button
                  key={u.unit}
                  onClick={() => handleUnitSelect(u)}
                  className="text-left rounded-xl px-5 py-3 transition-colors flex items-center justify-between gap-4"
                  style={{ background: hexToRgba(bookColor, 0.3), border: "1px solid " + hexToRgba(bookColor, 0.5) }}
                  onMouseEnter={e => e.currentTarget.style.background = hexToRgba(bookColor, 0.45)}
                  onMouseLeave={e => e.currentTarget.style.background = hexToRgba(bookColor, 0.3)}
                >
                  <div>
                    <span className="text-white text-sm font-medium">Unit {String(u.unit).replace(/^[BO]/i, '')}</span>
                    {u.topic && <span className="text-sm" style={{ color: "rgba(255,255,255,0.5)" }}> — {u.topic}</span>}
                  </div>
                  {u.is_optional && (
                    <span className="text-xs shrink-0" style={{ color: "rgba(255,255,255,0.4)" }}>(Optional)</span>
                  )}
                </button>
              ))}
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
                  onClick={() => window.open('/log-viewer', 'ConversationLog', 'width=720,height=560,resizable=yes')}
                  title="Open live conversation log"
                  className="pointer-events-auto backdrop-blur-sm text-white text-xs font-medium px-3 py-2 rounded-full transition-colors flex items-center gap-1"
                  style={{ background: "rgba(0,0,0,0.3)" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(0,0,0,0.5)"}
                  onMouseLeave={e => e.currentTarget.style.background = "rgba(0,0,0,0.3)"}
                >📋 Log</button>
                <button
                  onClick={() => {
                    const { conversationStartTime, sessionMinMs } = useAIStore.getState();
                    const elapsed = conversationStartTime ? Date.now() - conversationStartTime : 0;
                    if (elapsed < sessionMinMs) {
                      const remainingMin = Math.ceil((sessionMinMs - elapsed) / 60000);
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
            <div className="flex justify-center" style={{ paddingLeft: "20%" }}>
              <div className="pointer-events-auto backdrop-blur-md rounded-2xl flex flex-col items-center gap-3" style={{ background: "rgba(0,0,0,0.65)", border: "1px solid rgba(255,255,255,0.08)", padding: "1.2rem 2.5rem 1.5rem", width: "420px" }}>
                <AnimatePresence>
                  {micError && (
                    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} className="text-red-400 text-xs font-medium text-center max-w-[200px]">🎤 {micError}</motion.div>
                  )}
                </AnimatePresence>
                {/* Progress */}
                <p className="text-xs" style={{ color: "rgba(255,255,255,0.5)" }}>Progress</p>
                <ProgressBar bookColor={bookColor} />
                {/* Mic */}
                <p className="text-xs mt-2" style={{ color: "rgba(255,255,255,0.5)" }}>{status === "listening" ? "Release to send" : "Hold to speak"}</p>
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
    </div>
  );
}
