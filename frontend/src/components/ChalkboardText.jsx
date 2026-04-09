import { Html } from "@react-three/drei";
import { motion, AnimatePresence } from "framer-motion";
import useAIStore from "../store/useAIStore";

const CALIB_SENTENCES = [
  "Max, bist du da?",
  "Peter mag den Park.",
  "Oh, das ist traurig.",
  "schön, Schule, ich, Bach",
  "über, Öl, gut, so",
  "eins, Haus, Europa",
];

const CALIB_EMOTIONS = ["happy", "excited", "curious", "empathetic", "thinking", "concerned"];

// Positioned in world space on the chalkboard surface
export function ChalkboardText() {
  const messages = useAIStore((s) => s.messages);
  const calibrationMode = useAIStore((s) => s.calibrationMode);
  const calibrationPhase = useAIStore((s) => s.calibrationPhase);
  const calibrationSentenceIndex = useAIStore((s) => s.calibrationSentenceIndex);
  const calibrationEmotionIndex = useAIStore((s) => s.calibrationEmotionIndex);
  const debugData = useAIStore((s) => s.calibrationDebugData);

  // ── Calibration debug overlay ──
  if (calibrationMode) {
    let headerText = '';
    if (calibrationPhase === 'sentences' && calibrationSentenceIndex >= 0) {
      headerText = `Sentence ${calibrationSentenceIndex + 1}/6: "${CALIB_SENTENCES[calibrationSentenceIndex]}"`;
    } else if (calibrationPhase === 'emotions' && calibrationEmotionIndex >= 0) {
      headerText = `Emotion: ${CALIB_EMOTIONS[calibrationEmotionIndex]?.toUpperCase()}`;
    } else if (calibrationPhase === 'analyzing') {
      headerText = 'Analyzing...';
    } else if (calibrationPhase === 'done') {
      headerText = 'Calibration Complete';
    } else {
      headerText = 'Calibration Ready';
    }

    const d = debugData || {};

    return (
      <Html
        transform
        position={[0.8, 0.4, -5.7]}
        distanceFactor={2.5}
        style={{ pointerEvents: "none" }}
      >
        <div style={{ width: 560, minHeight: 180, padding: "12px 18px", fontFamily: "monospace", background: "rgba(0,0,0,0.75)", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.08)" }}>
          {/* Header */}
          <div style={{ color: "#7fff7f", fontSize: "16px", fontWeight: 700, marginBottom: "6px", textShadow: "0 0 6px rgba(100,255,100,0.5)" }}>
            {headerText}
          </div>

          {debugData && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 16px", fontSize: "11px", lineHeight: 1.6 }}>
              {/* Left column — viseme state */}
              <div>
                <div style={{ color: "#ffcc00", fontWeight: 700, fontSize: "12px" }}>VISEMES</div>
                <div style={{ color: d.dominantViseme !== 'viseme_sil' ? "#7fff7f" : "#888" }}>
                  Active: {d.dominantViseme} ({d.dominantVisemeWeight})
                </div>
                {['v_PP','v_FF','v_DD','v_kk','v_CH','v_SS','v_nn','v_RR','v_aa','v_E','v_I','v_O','v_U'].map(k => {
                  const val = parseFloat(d[k] || 0);
                  const bar = '█'.repeat(Math.round(val * 15));
                  return (
                    <div key={k} style={{ color: val > 0.05 ? "#e8f5e0" : "#555" }}>
                      {k.replace('v_','').padEnd(3)}: {(d[k]||'0.000')} {bar}
                    </div>
                  );
                })}
              </div>

              {/* Right column — emotion + banned channels */}
              <div>
                <div style={{ color: "#ffcc00", fontWeight: 700, fontSize: "12px" }}>EMOTION (upper-face)</div>
                <div style={{ color: "#7fc8ff" }}>Tag: {d.emotion || d.activeEmotionTag || 'neutral'}</div>
                <div style={{ color: "#aaa" }}>browInnerUp: {d.browInnerUp || '—'}</div>
                <div style={{ color: "#aaa" }}>cheekSquintL: {d.cheekSquintL || '—'}</div>

                <div style={{ color: "#ff6666", fontWeight: 700, fontSize: "12px", marginTop: "6px" }}>BANNED (should be 0)</div>
                {['mouthPucker','mouthFunnel','mouthClose','tongueOut'].map(k => {
                  const val = parseFloat(d[k] || 0);
                  return (
                    <div key={k} style={{ color: val > 0.001 ? "#ff4444" : "#555" }}>
                      {k}: {d[k] || '0.000'} {val > 0.001 ? '⚠' : '✓'}
                    </div>
                  );
                })}

                <div style={{ color: "#aaa", marginTop: "6px", fontSize: "10px" }}>
                  speech: {d.speechActive ? 'ON' : 'off'} | blend: {d.lowerBlend || '—'}
                </div>
              </div>
            </div>
          )}
        </div>
      </Html>
    );
  }

  // ── Normal mode: show last AI message ──
  let displayText = "";
  let turnKey = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].content) {
      displayText = messages[i].content;
      turnKey = i;
      break;
    }
  }

  return (
    <Html
      transform
      position={[0.4, 0.4, -5.7]}
      distanceFactor={2.5}
      style={{ pointerEvents: "none" }}
    >
      <div
        style={{
          width: 520,
          minHeight: 80,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "12px 20px",
        }}
      >
        <AnimatePresence mode="wait">
          {displayText ? (
            <motion.p
              key={turnKey}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              style={{
                margin: 0,
                textAlign: "center",
                color: "#e8f5e0",
                fontSize: "22px",
                fontWeight: 700,
                fontFamily: "'Segoe UI', system-ui, sans-serif",
                lineHeight: 1.5,
                letterSpacing: "0.02em",
                textShadow: "0 0 8px rgba(100,200,100,0.4), 1px 1px 2px rgba(0,0,0,0.6)",
                pointerEvents: "auto",
                userSelect: "text",
                cursor: "text",
              }}
            >
              {displayText}
            </motion.p>
          ) : (
            <motion.p key="empty" initial={{ opacity: 0 }} animate={{ opacity: 0 }} style={{ margin: 0 }} />
          )}
        </AnimatePresence>
      </div>
    </Html>
  );
}
