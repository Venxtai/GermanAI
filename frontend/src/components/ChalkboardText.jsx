import { Html } from "@react-three/drei";
import { motion, AnimatePresence } from "framer-motion";
import useAIStore from "../store/useAIStore";

// Positioned in world space on the chalkboard surface
// Classroom is at [0.2, -1.7, -2], board is toward the back
export function ChalkboardText() {
  // Subscribe to the messages array so every delta triggers a re-render.
  // Derive display text from the last non-empty assistant message and use
  // its stable array index as the AnimatePresence key so each new AI turn
  // always gets a unique key regardless of text content.
  const messages = useAIStore((s) => s.messages);

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
