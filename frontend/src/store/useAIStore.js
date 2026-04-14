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
  lipsyncNode: null,       // wLipSync AudioWorkletNode — poll .weights and .volume each frame
  currentEmotion: 'neutral', // Active emotion (updated during playback from timeline)
  emotionTimeline: null,     // [{start: 0.0-1.0, emotion}] from server
  emotionPlaybackStart: null, // performance.now() when audio started
  emotionAudioDuration: 0,   // audio duration in seconds

  // Auth
  accessCode: null,
  accessType: null,
  assignedTo: null,
  createdBy: null,

  // Mic selection & volume monitoring
  micAnalyser: null, // AnalyserNode from mic stream for real-time volume meter
  selectedMicId: null, // deviceId of chosen mic (null = browser default)

  // Mic error feedback
  micError: null,
  feedback: null,   // null | 'loading' | { items: string[] } | { fallback: true }
  transcriptForDownload: null, // saved messages for download after session ends

  // Progress bar timing
  conversationStartTime: null, // Date.now() when session started
  sessionMinMs: 0,             // minimum duration in ms
  sessionMaxMs: 0,             // maximum duration in ms

  // Calibration mode
  calibrationMode: false,        // whether calibration is active
  calibrationPhase: null,        // 'sentences' | 'emotions' | 'done'
  calibrationSentenceIndex: -1,  // which test sentence is playing
  calibrationEmotionIndex: -1,   // which emotion is being shown
  calibrationDebugData: null,    // latest frame debug snapshot from Character.jsx
  calibrationFrameLog: [],       // collected frame snapshots for analysis
  calibrationFeedback: '',       // user text feedback for tuning
  calibrationTuning: null,       // current tuning overrides from Claude
  calibrationAnalysis: null,     // latest analysis result from Claude

  // Actions
  setStatus: (status) => set({ status }),
  setMicError: (err) => set({ micError: err }),
  setFeedback: (fb) => set({ feedback: fb }),
  setAccessCode: (code) => set({ accessCode: code }),
  setAccessType: (type) => set({ accessType: type }),
  setAssignedTo: (name) => set({ assignedTo: name }),
  setCreatedBy: (name) => set({ createdBy: name }),
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

  setMicAnalyser: (node) => set({ micAnalyser: node }),
  setSelectedMicId: (id) => set({ selectedMicId: id }),
  setAnalyzerNode: (node) => set({ analyzerNode: node }),
  setLipsyncNode: (node) => set({ lipsyncNode: node }),
  clearLipsyncNode: () => set({ lipsyncNode: null }),
  setCurrentEmotion: (emotion) => set({ currentEmotion: emotion || 'neutral' }),
  setEmotionTimeline: (timeline, duration) => set({
    emotionTimeline: timeline,
    emotionAudioDuration: duration,
    emotionPlaybackStart: performance.now() - 220, // 220ms lead — emotion shows before audio (humans show intent before speaking)
    currentEmotion: timeline?.[0]?.emotion || 'neutral',
  }),
  clearEmotionTimeline: () => set({ emotionTimeline: null, emotionPlaybackStart: null, emotionAudioDuration: 0 }),
  setAudioAmplitude: (amp) => set({ audioAmplitude: amp }),

  // Calibration actions
  enterCalibration: () => set({ calibrationMode: true, calibrationPhase: null, calibrationSentenceIndex: -1, calibrationEmotionIndex: -1, calibrationFrameLog: [], calibrationAnalysis: null }),
  exitCalibration: () => set({ calibrationMode: false, calibrationPhase: null, calibrationSentenceIndex: -1, calibrationEmotionIndex: -1, calibrationDebugData: null, calibrationFrameLog: [], calibrationFeedback: '', calibrationTuning: null, calibrationAnalysis: null }),
  setCalibrationPhase: (phase) => set({ calibrationPhase: phase }),
  setCalibrationSentenceIndex: (i) => set({ calibrationSentenceIndex: i }),
  setCalibrationEmotionIndex: (i) => set({ calibrationEmotionIndex: i }),
  setCalibrationDebugData: (data) => set({ calibrationDebugData: data }),
  pushCalibrationFrame: (frame) => set((s) => ({ calibrationFrameLog: [...s.calibrationFrameLog, frame] })),
  clearCalibrationFrameLog: () => set({ calibrationFrameLog: [] }),
  setCalibrationFeedback: (text) => set({ calibrationFeedback: text }),
  setCalibrationTuning: (tuning) => set({ calibrationTuning: tuning }),
  setCalibrationAnalysis: (analysis) => set({ calibrationAnalysis: analysis }),
}));

export default useAIStore;
