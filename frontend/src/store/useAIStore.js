import { create } from "zustand";

const useAIStore = create((set, get) => ({
  // Session state
  status: "idle", // 'idle' | 'speaking' | 'listening' | 'loading'
  isSessionActive: false,
  currentUnit: 2,

  // Conversation
  messages: [],
  speakingText: "",  // live text of current AI utterance

  // Audio / lipsync
  audioAmplitude: 0,
  analyzerNode: null,
  visemeTimeline: null,    // Array of { time, viseme, weight, duration } from server
  visemeStartTime: null,   // performance.now() when audio playback started

  // Auth
  accessCode: null,
  accessType: null,
  assignedTo: null,

  // Mic error feedback
  micError: null,
  feedback: null,   // null | 'loading' | { items: string[] } | { fallback: true }
  transcriptForDownload: null, // saved messages for download after session ends

  // Progress bar timing
  conversationStartTime: null, // Date.now() when session started
  sessionMinMs: 0,             // minimum duration in ms
  sessionMaxMs: 0,             // maximum duration in ms

  // Actions
  setStatus: (status) => set({ status }),
  setMicError: (err) => set({ micError: err }),
  setFeedback: (fb) => set({ feedback: fb }),
  setAccessCode: (code) => set({ accessCode: code }),
  setAccessType: (type) => set({ accessType: type }),
  setAssignedTo: (name) => set({ assignedTo: name }),
  setTranscriptForDownload: (t) => set({ transcriptForDownload: t }),
  setCurrentUnit: (unit) => set({ currentUnit: unit }),
  setSessionActive: (active) => set({ isSessionActive: active }),
  setSessionTiming: (startTime, minMs, maxMs) => set({ conversationStartTime: startTime, sessionMinMs: minMs, sessionMaxMs: maxMs }),

  addMessage: (role, content) =>
    set((state) => ({
      messages: [...state.messages, { role, content }],
    })),

  updateLastAIMessage: (delta) =>
    set((state) => {
      const messages = [...state.messages];
      const lastMsg = messages[messages.length - 1];
      let speakingText;
      if (lastMsg && lastMsg.role === "assistant") {
        // Same utterance — append
        messages[messages.length - 1] = {
          ...lastMsg,
          content: lastMsg.content + delta,
        };
        speakingText = messages[messages.length - 1].content;
      } else {
        // New utterance — reset live text
        messages.push({ role: "assistant", content: delta });
        speakingText = delta;
      }
      return { messages, speakingText };
    }),

  finalizeAIMessage: (transcript) =>
    set((state) => {
      const messages = [...state.messages];
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        messages[messages.length - 1] = { ...lastMsg, content: transcript };
      } else {
        messages.push({ role: "assistant", content: transcript });
      }
      return { messages, speakingText: transcript };
    }),

  clearMessages: () => set({ messages: [], speakingText: "" }),

  // Call after each AI turn ends so next delta starts a fresh message
  prepareNewAIMessage: () =>
    set((state) => ({
      messages: [...state.messages, { role: "assistant", content: "" }],
      // speakingText intentionally NOT cleared — text stays until next AI turn begins
    })),

  setAnalyzerNode: (node) => set({ analyzerNode: node }),
  setVisemeTimeline: (timeline) => set({ visemeTimeline: timeline, visemeStartTime: performance.now() }),
  clearVisemeTimeline: () => set({ visemeTimeline: null, visemeStartTime: null }),
  setAudioAmplitude: (amp) => set({ audioAmplitude: amp }),
}));

export default useAIStore;
