import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import useAIStore from "../store/useAIStore";
import { useVoiceConnection } from "../hooks/useVoiceConnection";

const STATUS_LABELS = {
  idle: "Ready",
  listening: "Listening…",
  speaking: "Speaking…",
  loading: "Thinking…",
};

const BOOKS = [
  { id: "ID1",  label: "Impuls Deutsch 1",          style: { background: "rgba(255,255,255,0.08)",  border: "1px solid rgba(255,255,255,0.15)" } },
  { id: "ID2B", label: "Impuls Deutsch 2 — BLAU",   style: { background: "rgba(37,99,235,0.35)",    border: "1px solid rgba(96,165,250,0.6)"  } },
  { id: "ID2O", label: "Impuls Deutsch 2 — ORANGE", style: { background: "rgba(234,88,12,0.35)",    border: "1px solid rgba(251,146,60,0.6)"  } },
];

const CHAPTERS_BY_BOOK = {
  ID1: [
    { chapter: 1, title: "Wer bin ich?: Heute und in der Zukunft",                                         unitStart: 1,  unitEnd: 15  },
    { chapter: 2, title: "Was ziehe ich an?: Wetter und Klimawandel",                                       unitStart: 16, unitEnd: 26  },
    { chapter: 3, title: "Was ist da drin? Lebensmittel unter der Lupe",                                    unitStart: 27, unitEnd: 37  },
    { chapter: 4, title: "Wie gestalte ich mein Leben?: \u201eSchlanke Produktion\u201c f\u00fcr Haus und Alltag", unitStart: 38, unitEnd: 52  },
    { chapter: 5, title: "Woher kommen meine Sachen?: Konsum, Verpackungen, M\u00fclltrennung",             unitStart: 53, unitEnd: 67  },
    { chapter: 6, title: "Wie war es damals?: Kindheit im Wandel der Zeit",                                 unitStart: 68, unitEnd: 79  },
    { chapter: 7, title: "Was gibt's da zu sehen?: Sehensw\u00fcrdigkeiten in Wien",                        unitStart: 80, unitEnd: 93  },
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

export function UI() {
  // Selection flow: 'book' | 'chapter' | 'unit' | 'welcome' | 'session'
  const [screen, setScreen] = useState("book");
  const [selectedBook, setSelectedBook] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [units, setUnits] = useState([]);
  const [selectedChapter, setSelectedChapter] = useState(null);
  const [pendingUnit, setPendingUnit] = useState(null);
  const [error, setError] = useState(null);
  const holdTimerRef = useRef(null);
  const isHoldingRef = useRef(false);

  const { status, isSessionActive, micError, setMicError, feedback, setFeedback } = useAIStore();

  // Auto-dismiss mic error after 4 seconds
  useEffect(() => {
    if (!micError) return;
    const t = setTimeout(() => setMicError(null), 4000);
    return () => clearTimeout(t);
  }, [micError, setMicError]);
  const { startConversation, endConversation, startRecording, stopRecording, isRecordingRef } =
    useVoiceConnection();

  // Track previous session state so we only reset when a session *ends* (true → false)
  const wasSessionActiveRef = useRef(false);
  useEffect(() => {
    if (wasSessionActiveRef.current && !isSessionActive) {
      // Session just ended — show feedback screen; Done button handles returning to book picker
      setScreen("feedback");
    }
    wasSessionActiveRef.current = isSessionActive;
  }, [isSessionActive]);

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
      const fullUnit = await fetch(`/api/units/${unitInfo.unit}`).then((r) => r.json());
      // Attach book/chapter so startConversation can request the right persona
      fullUnit._book = selectedBook?.id || 'ID1';
      fullUnit._chapter = selectedChapter?.chapter || 1;
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
      await startConversation(pendingUnit);
    } catch {
      setError("Failed to connect. Is the server running?");
      setScreen("unit");
    }
  };

  const handleFeedbackDone = () => {
    setFeedback(null);
    setScreen("book");
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
    // Use a ref rather than `status` to avoid the React stale-closure race:
    // when the user releases very quickly after the 100ms timer fires,
    // the component may not have re-rendered with status="listening" yet.
    if (isRecordingRef.current) stopRecording();
  };

  return (
    <div className="fixed inset-0 pointer-events-none select-none">

      {/* ── Book selection ── */}
      <AnimatePresence>
        {screen === "book" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ paddingLeft: "50%" }}
            className="pointer-events-auto absolute inset-0 flex items-center justify-start"
          >
            <div className="bg-black/60 backdrop-blur-md rounded-2xl p-8 w-[420px] flex flex-col gap-4">
              <h1 className="text-white text-xl font-bold text-center">Impuls Deutsch</h1>
              <p className="text-white/60 text-sm text-center">Select your textbook</p>
              {BOOKS.map((book) => (
                <button
                  key={book.id}
                  onClick={() => handleBookSelect(book)}
                  style={book.style}
                  className="text-left rounded-xl px-5 py-4 transition-colors w-full"
                >
                  <p className="text-white text-sm font-medium">{book.label}</p>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Chapter selection ── */}
      <AnimatePresence>
        {screen === "chapter" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ paddingLeft: "50%" }}
            className="pointer-events-auto absolute inset-0 flex items-center justify-start"
          >
            <div className="bg-black/60 backdrop-blur-md rounded-2xl p-8 w-[480px] max-h-[80vh] overflow-y-auto flex flex-col gap-4">
              <button
                  onClick={() => { setScreen("book"); setError(null); }}
                  className="text-white/50 hover:text-white text-xs self-start transition-colors"
                >
                  ← Back
                </button>
              <h1 className="text-white text-xl font-bold text-center">Chapters</h1>
              <p className="text-white/60 text-sm text-center">{selectedBook?.label}</p>
              {error && <p className="text-red-400 text-xs text-center">{error}</p>}
              {chapters.map((ch) => (
                <button
                  key={ch.chapter}
                  onClick={() => handleChapterSelect(ch)}
                  className="text-left bg-white/10 hover:bg-white/20 rounded-xl px-5 py-3 transition-colors"
                >
                  <span className="text-white/50 text-xs font-mono">Ch. {ch.chapter}</span>
                  <p className="text-white text-sm font-medium mt-0.5">{ch.title}</p>
                  {ch.unitStart && (
                    <p className="text-white/40 text-xs mt-0.5">Units {ch.unitStart}–{ch.unitEnd}</p>
                  )}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Unit selection ── */}
      <AnimatePresence>
        {screen === "unit" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ paddingLeft: "50%" }}
            className="pointer-events-auto absolute inset-0 flex items-center justify-start"
          >
            <div className="bg-black/60 backdrop-blur-md rounded-2xl p-8 w-[480px] max-h-[80vh] overflow-y-auto flex flex-col gap-3">
              <button
                onClick={() => { setScreen("chapter"); }}
                className="text-white/50 hover:text-white text-xs self-start transition-colors"
              >
                ← Back
              </button>
              <h2 className="text-white text-lg font-bold">
                {selectedBook?.label} · Chapter {selectedChapter?.chapter}
              </h2>
              <p className="text-white/60 text-sm">What is the last unit you covered in class?</p>
              {error && <p className="text-red-400 text-xs">{error}</p>}
              {units.map((u) => (
                <button
                  key={u.unit}
                  onClick={() => handleUnitSelect(u)}
                  className="text-left bg-white/10 hover:bg-white/20 rounded-xl px-5 py-3 transition-colors flex items-center justify-between gap-4"
                >
                  <span className="text-white text-sm">Unit {u.unit}</span>
                  {u.is_optional && (
                    <span className="text-white/40 text-xs shrink-0">(Optional)</span>
                  )}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Welcome screen ── */}
      <AnimatePresence>
        {screen === "welcome" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ paddingLeft: "50%" }}
            className="pointer-events-auto absolute inset-0 flex items-center justify-start"
          >
            <div className="bg-black/70 backdrop-blur-md rounded-2xl p-8 w-[500px] flex flex-col gap-5">
              <button
                onClick={() => setScreen("unit")}
                className="text-white/50 hover:text-white text-xs self-start transition-colors"
              >
                ← Back
              </button>

              <h2 className="text-white text-xl font-bold">Welcome to the German Conversation Buddy!</h2>

              <ul className="flex flex-col gap-3 text-white/80 text-sm">
                <li className="flex gap-2">
                  <span className="text-white/40 shrink-0">•</span>
                  Speak only in German during the conversation.
                </li>
                <li className="flex gap-2">
                  <span className="text-white/40 shrink-0">•</span>
                  If you don't understand something, say{" "}
                  <span className="text-white font-medium">"Wie bitte?"</span>
                  {" "}or{" "}
                  <span className="text-white font-medium">"Noch einmal, bitte."</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-white/40 shrink-0">•</span>
                  Answer the buddy's questions, but also ask your own questions!
                </li>
                <li className="flex gap-2">
                  <span className="text-white/40 shrink-0">•</span>
                  Pay attention to the buddy's answers — you may need them later.
                </li>
              </ul>

              <p className="text-white/50 text-xs text-center">When you're ready, click the button below to begin.</p>

              <button
                onClick={handleStartSession}
                className="bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
                Start Conversation
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Feedback screen ── */}
      <AnimatePresence>
        {screen === "feedback" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ paddingLeft: "50%" }}
            className="pointer-events-auto absolute inset-0 flex items-center justify-start"
          >
            <div className="bg-black/70 backdrop-blur-md rounded-2xl p-8 w-[500px] flex flex-col gap-5">
              <h2 className="text-white text-xl font-bold">Session Complete 🎉</h2>

              {feedback === 'loading' && (
                <div className="flex items-center gap-3 text-white/60 text-sm">
                  <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Generating your feedback…
                </div>
              )}

              {feedback?.fallback && (
                <p className="text-white/70 text-sm">
                  The conversation was a bit short this time. Try a longer session to get detailed feedback on what you practiced!
                </p>
              )}

              {feedback?.items?.length > 0 && (
                <>
                  <p className="text-white/70 text-sm">Here's what you practiced today:</p>
                  <ul className="flex flex-col gap-2">
                    {feedback.items.map((item, i) => (
                      <li key={i} className="flex gap-2 text-white/90 text-sm">
                        <span className="text-green-400 shrink-0">✓</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {feedback !== 'loading' && (
                <button
                  onClick={handleFeedbackDone}
                  className="mt-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl transition-colors"
                >
                  Done
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Connecting spinner (session requested, not yet active) ── */}
      <AnimatePresence>
        {screen === "session" && !isSessionActive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center"
          >
            <div className="bg-black/40 backdrop-blur-sm rounded-2xl px-8 py-5 flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-4 border-white/30 border-t-white rounded-full animate-spin" />
              <p className="text-white text-sm font-medium">Connecting…</p>
              <button
                onClick={() => setScreen("unit")}
                className="pointer-events-auto text-white/40 hover:text-white text-xs transition-colors"
              >
                Cancel
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Active session UI ── */}
      <AnimatePresence>
        {isSessionActive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-0 flex flex-col justify-between p-6"
          >
            {/* Top bar */}
            <div className="flex justify-between items-start">
              {/* Left: status pill */}
              <div className="bg-black/30 backdrop-blur-sm rounded-full px-4 py-2 flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${
                  status === "listening" ? "bg-green-400 animate-pulse"
                  : status === "speaking" ? "bg-blue-400 animate-pulse"
                  : status === "loading"  ? "bg-yellow-400 animate-pulse"
                  : "bg-gray-400"
                }`} />
                <span className="text-white text-xs font-medium">
                  {STATUS_LABELS[status] || "Ready"}
                </span>
              </div>

              {/* Right: log viewer + book selector + end session */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.open('/log-viewer', 'ConversationLog', 'width=720,height=560,resizable=yes')}
                  title="Open live conversation log"
                  className="pointer-events-auto bg-black/30 hover:bg-black/50 backdrop-blur-sm text-white text-xs font-medium px-3 py-2 rounded-full transition-colors flex items-center gap-1"
                >
                  📋 Log
                </button>
                <button
                  onClick={() => { endConversation(); setScreen("book"); setPendingUnit(null); }}
                  title="Change book / chapter"
                  className="pointer-events-auto bg-black/30 hover:bg-black/50 backdrop-blur-sm text-white w-9 h-9 rounded-full flex items-center justify-center transition-colors text-lg"
                >
                  📚
                </button>
                <button
                  onClick={endConversation}
                  className="pointer-events-auto bg-red-500/80 hover:bg-red-500 backdrop-blur-sm text-white text-xs font-medium px-4 py-2 rounded-full transition-colors"
                >
                  End Session
                </button>
              </div>
            </div>

            {/* Hold-to-speak mic button */}
            <div className="flex flex-col items-center gap-3">
              <AnimatePresence>
                {micError && (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                    className="text-red-400 text-xs font-medium bg-black/60 border border-red-500/40 rounded-lg px-3 py-1.5 text-center max-w-[200px]"
                  >
                    🎤 {micError}
                  </motion.div>
                )}
              </AnimatePresence>
              <p className="text-white/50 text-xs">
                {status === "listening" ? "Release to send" : "Hold to speak"}
              </p>
              <motion.button
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
                disabled={status === "speaking" || status === "loading"}
                whileTap={{ scale: 0.92 }}
                className={`pointer-events-auto w-20 h-20 rounded-full flex items-center justify-center shadow-2xl transition-colors border-4 ${
                  status === "listening"
                    ? "bg-green-500 border-green-300 animate-pulse"
                    : status === "speaking" || status === "loading"
                    ? "bg-gray-500 border-gray-400 opacity-50 cursor-not-allowed"
                    : "bg-blue-600 border-blue-400 hover:bg-blue-500"
                }`}
              >
                <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24"
                  stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

