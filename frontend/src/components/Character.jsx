import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF, useAnimations } from "@react-three/drei";
import { MathUtils } from "three";
import { randInt } from "three/src/math/MathUtils";
import useAIStore from "../store/useAIStore";

/**
 * Native-viseme speech + upper-face emotion for Avaturn avatar.
 *
 * v5 — Model-native viseme architecture.
 *
 * Key principle: speech is driven ONLY by the model's baked-in viseme_*
 * morph targets. ARKit mouth deformation channels (mouthPucker, mouthFunnel,
 * mouthRollLower, mouthPress*, tongueOut, etc.) are BANNED during speech.
 * Emotions during speech are upper-face only (brows, eyes, cheeks).
 */

// ════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ════════════════════════════════════════════════════════════════════

// Viseme application delay (ms) — delays lip shapes relative to audio
// to fix mouth-leads-audio by ~130ms. Does NOT affect emotion preload.
const VISUAL_SPEECH_OFFSET_MS = 50;

// §2 — PP bilabial onset parameters
const PP_HOLD_MS = 55;           // minimum hold for explicit PP
const PP_ONSET_BOOST = 0.14;     // extra weight on first PP frame
const PP_MOUTHCLOSE_MAX = 0.05;  // mouthClose assist cap during PP

// ── Model's native viseme targets (the ONLY speech drivers) ──
const NATIVE_VISEMES = [
  "viseme_sil", "viseme_PP", "viseme_FF", "viseme_TH",
  "viseme_DD", "viseme_kk", "viseme_CH", "viseme_SS",
  "viseme_nn", "viseme_RR", "viseme_aa", "viseme_E",
  "viseme_I", "viseme_O", "viseme_U",
];

// §4 — Per-viseme max weight caps (model-specific)
const VISEME_MAX_WEIGHT = {
  viseme_sil: 1.00,
  viseme_PP:  1.00,
  viseme_FF:  0.90,
  viseme_TH:  0.00,  // banned for German
  viseme_DD:  0.90,
  viseme_kk:  0.90,
  viseme_SS:  0.68,  // reduced — was over-dominant
  viseme_CH:  0.72,  // reduced — CH/SCH needs more distinction
  viseme_RR:  0.58,  // reduced — forward lip effect
  viseme_aa:  0.85,
  viseme_E:   0.82,
  viseme_I:   0.82,
  viseme_O:   0.52,  // reduced — too vertically open
  viseme_U:   0.38,  // reduced — pushes lower lip forward
};

// §2 — wLipSync phoneme → native viseme mapping for German
const PHONEME_TO_NATIVE_VISEME = {
  A: "viseme_aa",  // a, aː
  E: "viseme_E",   // e, eː, ɛ — also closest for ö-family
  I: "viseme_I",   // i, iː, ɪ — also closest for ü-family
  O: "viseme_O",   // o, oː, ɔ — also used for ö approximation
  U: "viseme_U",   // u, uː, ʊ — also used for ü approximation
  S: "viseme_SS",  // s, z, ß
};

// §2b — Diphthong transitions: smooth blend between two visemes over ~110ms
// First component biased stronger (0.6 → 0.4 blend)
const DIPHTHONGS = {
  // ei: aa → I (as in "mein", "Eis")
  ei: { from: 'viseme_aa', to: 'viseme_I', durationMs: 110, bias: 0.6 },
  // au: aa → U (as in "Haus", "auch")
  au: { from: 'viseme_aa', to: 'viseme_U', durationMs: 110, bias: 0.6 },
  // eu/äu: O → I (as in "heute", "Häuser")
  eu: { from: 'viseme_O', to: 'viseme_I', durationMs: 100, bias: 0.55 },
};

// §3 — ARKit channels BANNED during speech (forced to 0 every frame)
const BANNED_DURING_SPEECH = new Set([
  "mouthPucker", "mouthFunnel",
  "mouthRollLower", "mouthRollUpper",
  "mouthPressLeft", "mouthPressRight",
  "mouthLowerDownLeft", "mouthLowerDownRight",
  "mouthShrugLower", "mouthShrugUpper",
  "tongueOut",
  "viseme_TH",
]);

// All ARKit mouth shapes (for idle reset sweeps)
const ARKIT_MOUTH_SHAPES = [
  "jawOpen", "jawForward", "jawLeft", "jawRight",
  "mouthOpen", "mouthClose", "mouthFunnel", "mouthPucker",
  "mouthLeft", "mouthRight", "mouthRollUpper", "mouthRollLower",
  "mouthShrugUpper", "mouthShrugLower", "mouthPressLeft", "mouthPressRight",
  "mouthStretchLeft", "mouthStretchRight", "mouthDimpleLeft", "mouthDimpleRight",
  "mouthUpperUpLeft", "mouthUpperUpRight", "mouthLowerDownLeft", "mouthLowerDownRight",
  "mouthFrownLeft", "mouthFrownRight", "tongueOut",
  "noseSneerLeft", "noseSneerRight", "cheekPuff",
];

// §7 — Lower-face emotion channels (zeroed during speech, restored in idle)
const LOWER_FACE_EMOTION_CHANNELS = new Set([
  "mouthSmileLeft", "mouthSmileRight", "mouthSmile",
  "mouthFrownLeft", "mouthFrownRight",
  "mouthPucker", "mouthFunnel",
  "mouthShrugUpper", "mouthShrugLower",
  "mouthDimpleLeft", "mouthDimpleRight",
  "mouthStretchLeft", "mouthStretchRight",
  "mouthRollUpper", "mouthRollLower",
  "mouthPressLeft", "mouthPressRight",
  "jawForward",
]);

// §7 — Upper-face shapes (always active, even during speech)
const UPPER_FACE_SHAPES = [
  "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
  "eyeWideLeft", "eyeWideRight", "eyeSquintLeft", "eyeSquintRight",
  "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight",
  "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
  "cheekSquintLeft", "cheekSquintRight", "cheekPuff",
  "noseSneerLeft", "noseSneerRight",
];

const ALL_EMOTION_SHAPES = [
  ...UPPER_FACE_SHAPES,
  ...LOWER_FACE_EMOTION_CHANNELS,
];

// ════════════════════════════════════════════════════════════════════
//  §7  EMOTION PRESETS (upper-face-first during speech)
// ════════════════════════════════════════════════════════════════════

const EMOTIONS = {
  neutral: {
    eyeSquintLeft: 0.05, eyeSquintRight: 0.05,
    browInnerUp: 0.0,
  },
  // HAPPY: warm, lifted — browOuterUp +0.02
  happy: {
    mouthSmileLeft: 0.55, mouthSmileRight: 0.55,
    cheekSquintLeft: 0.58, cheekSquintRight: 0.58,
    eyeSquintLeft: 0.32, eyeSquintRight: 0.32,
    browOuterUpLeft: 0.16, browOuterUpRight: 0.16,
  },
  // EXCITED: browInnerUp +0.06, eyeWide +0.08, smile -0.04, cheekSquint -0.03
  excited: {
    browInnerUp: 0.61,
    eyeWideLeft: 0.50, eyeWideRight: 0.50,
    cheekSquintLeft: 0.23, cheekSquintRight: 0.23,
    mouthSmileLeft: 0.56, mouthSmileRight: 0.56,
  },
  // CURIOUS: browOuterUpLeft +0.05, stronger eye asymmetry
  curious: {
    browOuterUpLeft: 1.0, browOuterUpRight: 0.12,
    browDownRight: 0.52,
    eyeWideLeft: 0.40, eyeWideRight: 0.12,
  },
  // EMPATHETIC: browDown -0.02 (slightly less)
  empathetic: {
    browInnerUp: 0.86,
    browDownLeft: 0.50, browDownRight: 0.50,
    eyeSquintLeft: 0.10, eyeSquintRight: 0.10,
    eyeLookDownLeft: 0.14, eyeLookDownRight: 0.14,
    mouthFrownLeft: 0.72, mouthFrownRight: 0.72,
    mouthPressLeft: 0.06, mouthPressRight: 0.06,
  },
  // THINKING: stronger one-sided brow +0.05, eyeLookUp +0.04
  thinking: {
    browOuterUpLeft: 0.60, browOuterUpRight: 0.10,
    browInnerUp: 0.15,
    eyeLookUpLeft: 0.29, eyeLookUpRight: 0.29,
    eyeLookOutLeft: 0.18, eyeLookInRight: 0.18,
  },
  surprised: {
    browInnerUp: 0.9,
    eyeWideLeft: 0.7, eyeWideRight: 0.7,
  },
  // CONCERNED: browDown +0.04, browInnerUp -0.03, eyeSquint +0.03, eyeLookDown reduced
  concerned: {
    browInnerUp: 0.65,
    browDownLeft: 0.26, browDownRight: 0.26,
    eyeSquintLeft: 0.17, eyeSquintRight: 0.17,
    eyeLookDownLeft: 0.03, eyeLookDownRight: 0.03,
    noseSneerLeft: 0.08, noseSneerRight: 0.08,
    mouthFrownLeft: 0.38, mouthFrownRight: 0.38,
  },
};

// ════════════════════════════════════════════════════════════════════
//  EMOTION KEYWORDS (German text → emotion detection)
// ════════════════════════════════════════════════════════════════════

const EMOTION_KEYWORDS = {
  happy: [
    "toll", "super", "schön", "wunderbar", "fantastisch", "prima", "klasse",
    "freut", "freue", "freuen", "freude", "spaß", "lustig", "lachen",
    "gern", "gerne", "liebe", "lieben", "mag", "cool", "perfekt",
    "genau", "ja", "natürlich", "klar", "richtig", "stimmt",
    "willkommen", "hallo", "hi",
  ],
  excited: [
    "wow", "echt", "wirklich", "unglaublich", "wahnsinn", "krass",
    "interessant", "spannend", "aufregend", "neu", "großartig",
    "erzähl", "erzähle", "erzählen",
  ],
  curious: [
    "warum", "wieso", "weshalb", "wie", "was", "wer", "wo", "wann",
    "woher", "wohin", "welch", "stimmt das", "meinst du", "findest du",
    "glaubst du", "denkst du", "kennst du",
  ],
  empathetic: [
    "schade", "leider", "tut mir leid", "verstehe", "schwer", "schwierig",
    "traurig", "müde", "krank", "problem", "sorge", "angst",
    "keine sorge", "kein problem", "macht nichts",
    "höre dich nicht", "nicht gut", "noch einmal", "nochmal",
    "entschuldigung", "sorry", "oh nein", "nicht verstanden",
  ],
  thinking: [
    "hmm", "also", "vielleicht", "möglicherweise", "eigentlich",
    "ich denke", "ich glaube", "ich meine", "mal sehen", "lass mich",
    "überlegen", "moment",
  ],
};

function detectEmotion(text) {
  if (!text) return "neutral";
  const lower = text.toLowerCase();
  if (lower.includes("?")) {
    for (const word of EMOTION_KEYWORDS.excited) {
      if (lower.includes(word)) return "excited";
    }
    return "curious";
  }
  const hasExclamation = lower.includes("!");
  let bestEmotion = "neutral";
  let bestScore = 0;
  for (const [emotion, keywords] of Object.entries(EMOTION_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (lower.includes(keyword)) score++;
    }
    if (hasExclamation && (emotion === "happy" || emotion === "excited")) score += 0.5;
    if (score > bestScore) { bestScore = score; bestEmotion = emotion; }
  }
  return bestScore > 0 ? bestEmotion : "neutral";
}

// ════════════════════════════════════════════════════════════════════
//  COMPONENT
// ════════════════════════════════════════════════════════════════════

export function Character(props) {
  const group = useRef();
  const { scene, animations } = useGLTF("/models/AvaturnAvatar.glb");
  const { actions } = useAnimations(animations, scene);

  const [blink, setBlink] = useState(false);
  const [ready, setReady] = useState(false);

  const status             = useAIStore((s) => s.status);
  const analyzerNode       = useAIStore((s) => s.analyzerNode);
  const lipsyncNode        = useAIStore((s) => s.lipsyncNode);
  const currentEmotion     = useAIStore((s) => s.currentEmotion);
  const emotionTimeline    = useAIStore((s) => s.emotionTimeline);
  const emotionPlaybackStart = useAIStore((s) => s.emotionPlaybackStart);
  const emotionAudioDuration = useAIStore((s) => s.emotionAudioDuration);
  const setCurrentEmotion  = useAIStore((s) => s.setCurrentEmotion);
  const calibrationMode    = useAIStore((s) => s.calibrationMode);
  const calibrationTuning  = useAIStore((s) => s.calibrationTuning);

  const freqDataRef = useRef(null);
  const neckBoneRef = useRef(null);
  const saccadeRef = useRef({ x: 0, y: 0, nextTime: 0 });

  // Micro-motion humanization refs
  const headDriftRef = useRef({ x: 0, y: 0, targetX: 0, targetY: 0, nextTime: 0 });
  const browNoiseRef = useRef({ left: 0, right: 0, targetL: 0, targetR: 0, nextTime: 0 });

  // Speech-state gate refs
  const speechActiveRef = useRef(false);
  const speechReleaseTimerRef = useRef(0);
  const lowerFaceBlendRef = useRef(0); // 0 = zeroed (speech), 1 = full emotion (idle)

  // Native viseme crossfade state
  const prevVisemeWeightsRef = useRef({}); // viseme_name → weight from previous frame
  // PP bilabial hold timer
  const ppHoldUntilRef = useRef(0);       // performance.now() deadline
  const ppOnsetFrameRef = useRef(false);  // true on first frame PP is detected

  // Diphthong transition state
  const diphthongRef = useRef({ active: null, startTime: 0 });

  // §1 — Viseme offset: ring buffer to delay viseme weights
  const visemeBufferRef = useRef([]);
  const visemeReadyRef = useRef(null);

  // §6 — Phrase-based emotion switching
  const emotionSwitchCountRef = useRef(0);
  const lastEmotionSwitchTimeRef = useRef(0);

  // §10 — Debug overlay ref
  const debugRef = useRef({});

  const { avatarLayer, ...restProps } = props;

  // ── Material fix & bone discovery ──
  useEffect(() => {
    scene.traverse((child) => {
      if (child.isBone && (child.name === 'Neck' || child.name === 'neck')) {
        neckBoneRef.current = child;
      }
    });
    scene.traverse((child) => {
      if (avatarLayer !== undefined && child.isMesh) child.layers.enable(avatarLayer);
      if (child.material) {
        const mat = child.material;
        const name = (mat.name || "").toLowerCase();
        if (name.includes("glasses_1")) return;
        if (mat.metalnessMap) mat.metalnessMap = null;
        mat.metalness = 0;
        if (mat.color) mat.color.set(0xffffff);
        mat.needsUpdate = true;
      }
    });
  }, [scene]);

  // ── Idle animation ──
  useEffect(() => {
    if (animations && animations.length > 0) {
      const clip = animations[0];
      clip.tracks = clip.tracks.filter(
        (track) => !track.name.includes("morphTargetInfluences") && !track.name.includes("Neck")
      );
      clip.duration = 3.3;
    }
    if (actions && Object.keys(actions).length > 0) {
      const firstAction = Object.values(actions)[0];
      if (firstAction) {
        firstAction.reset().setLoop(2202, Infinity).play();
        setReady(true);
      }
    }
  }, [actions, animations]);

  // ── Blink loop (humanized: clusters of 1-2 blinks with natural variance) ──
  useEffect(() => {
    let blinkTimeout;
    const nextBlink = () => {
      // Natural blink interval: 2-6s, occasional fast double-blinks
      const isDoubleBlink = Math.random() < 0.2;
      const interval = isDoubleBlink
        ? randInt(150, 300)  // quick follow-up blink
        : randInt(2000, 6000); // normal interval

      blinkTimeout = setTimeout(() => {
        setBlink(true);
        // Blink duration: 80-160ms (varies naturally)
        setTimeout(() => { setBlink(false); nextBlink(); }, randInt(80, 160));
      }, interval);
    };
    nextBlink();
    return () => clearTimeout(blinkTimeout);
  }, []);

  // Log when calibration tuning changes
  useEffect(() => {
    if (calibrationTuning) {
      console.log('[Character] Calibration tuning APPLIED:', JSON.stringify(calibrationTuning));
    }
  }, [calibrationTuning]);

  // Reset utterance tracking when speech starts
  useEffect(() => {
    if (status === 'speaking') {
      emotionSwitchCountRef.current = 0;
      visemeBufferRef.current = [];
      prevVisemeWeightsRef.current = {};
    }
  }, [status]);

  // ── Morph-target helpers ──
  const lerpMorphTarget = (targetName, value, speed = 0.1) => {
    scene.traverse((child) => {
      if (child.isSkinnedMesh && child.morphTargetDictionary) {
        const index = child.morphTargetDictionary[targetName];
        if (index === undefined || child.morphTargetInfluences[index] === undefined) return;
        child.morphTargetInfluences[index] = MathUtils.lerp(
          child.morphTargetInfluences[index], value, speed
        );
      }
    });
  };

  const setMorphTarget = (targetName, value) => {
    scene.traverse((child) => {
      if (child.isSkinnedMesh && child.morphTargetDictionary) {
        const index = child.morphTargetDictionary[targetName];
        if (index === undefined || child.morphTargetInfluences[index] === undefined) return;
        child.morphTargetInfluences[index] = value;
      }
    });
  };

  const getCurrent = (targetName) => {
    let val = 0;
    scene.traverse((child) => {
      if (child.isSkinnedMesh && child.morphTargetDictionary) {
        const index = child.morphTargetDictionary[targetName];
        if (index !== undefined && child.morphTargetInfluences[index] !== undefined) {
          val = child.morphTargetInfluences[index];
        }
      }
    });
    return val;
  };

  // ── Audio amplitude (100-4000 Hz band) ──
  const getAudioAmplitude = () => {
    if (!analyzerNode) return 0;
    if (!freqDataRef.current || freqDataRef.current.length !== analyzerNode.frequencyBinCount) {
      freqDataRef.current = new Uint8Array(analyzerNode.frequencyBinCount);
    }
    analyzerNode.getByteFrequencyData(freqDataRef.current);
    const data = freqDataRef.current;
    const binCount = data.length;
    const sampleRate = analyzerNode.context?.sampleRate || 48000;
    const hzPerBin = sampleRate / (binCount * 2);
    const loBin = Math.max(1, Math.floor(100 / hzPerBin));
    const hiBin = Math.min(binCount - 1, Math.ceil(4000 / hzPerBin));
    let sum = 0;
    for (let i = loBin; i <= hiBin; i++) sum += data[i];
    return MathUtils.clamp(sum / ((hiBin - loBin + 1) * 255), 0, 1);
  };

  // ═══════════════════════════════════════════════════════════════════
  //  PER-FRAME UPDATE
  // ═══════════════════════════════════════════════════════════════════
  useFrame((_, delta) => {
    const now = performance.now();
    const dtMs = delta * 1000;

    // ── Blink ──
    lerpMorphTarget("eyeBlinkLeft", blink ? 1 : 0, 0.5);
    lerpMorphTarget("eyeBlinkRight", blink ? 1 : 0, 0.5);

    // ══════════════════════════════════════════════════════════════
    //  PHRASE-BASED EMOTION TIMELINE
    // ══════════════════════════════════════════════════════════════
    if (status === "speaking" && emotionTimeline && emotionTimeline.length > 1 && emotionPlaybackStart && emotionAudioDuration > 0) {
      const elapsed = (now - emotionPlaybackStart) / 1000;
      const progress = MathUtils.clamp(elapsed / emotionAudioDuration, 0, 1);
      let activeEmotion = emotionTimeline[0].emotion;
      for (let i = emotionTimeline.length - 1; i >= 0; i--) {
        if (progress >= emotionTimeline[i].start) {
          activeEmotion = emotionTimeline[i].emotion;
          break;
        }
      }

      if (activeEmotion !== currentEmotion) {
        const isFirstTag = emotionSwitchCountRef.current === 0;
        if (isFirstTag) {
          setCurrentEmotion(activeEmotion);
          emotionSwitchCountRef.current++;
          lastEmotionSwitchTimeRef.current = now;
        } else {
          const timeSinceLastSwitch = now - lastEmotionSwitchTimeRef.current;
          if (timeSinceLastSwitch >= 120) {
            setCurrentEmotion(activeEmotion);
            emotionSwitchCountRef.current++;
            lastEmotionSwitchTimeRef.current = now;
          }
        }
      }
    }

    // ══════════════════════════════════════════════════════════════
    //  SPEECH-STATE GATE
    // ══════════════════════════════════════════════════════════════
    const amplitude = (status === "speaking") ? getAudioAmplitude() : 0;

    let phonemeConfidence = 0;
    let currentWeights = null;
    if (lipsyncNode && lipsyncNode.weights) {
      currentWeights = lipsyncNode.weights;
      for (const k of Object.keys(currentWeights)) {
        if (currentWeights[k] > phonemeConfidence) phonemeConfidence = currentWeights[k];
      }
    }

    // §1 — Buffer viseme weights for delayed application
    if (currentWeights && status === "speaking") {
      visemeBufferRef.current.push({ timestamp: now, weights: { ...currentWeights } });
    }
    const targetVisemeTime = now - VISUAL_SPEECH_OFFSET_MS;
    visemeReadyRef.current = null;
    const buf = visemeBufferRef.current;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].timestamp <= targetVisemeTime) {
        visemeReadyRef.current = buf[i].weights;
        if (i > 1) buf.splice(0, i - 1);
        break;
      }
    }
    if (buf.length > 500) buf.splice(0, buf.length - 300);

    // Gate: active when phoneme or amplitude above threshold
    const rawActive = (phonemeConfidence > 0.18 || amplitude > 0.025) && status === "speaking";
    if (rawActive) {
      speechActiveRef.current = true;
      speechReleaseTimerRef.current = now;
    } else if (speechActiveRef.current) {
      if (now - speechReleaseTimerRef.current > 80) {
        speechActiveRef.current = false;
      }
    }
    const speechActive = speechActiveRef.current;

    // Lower-face blend (0 = zeroed for speech, 1 = full emotion idle)
    if (speechActive) {
      lowerFaceBlendRef.current = 0;
    } else {
      const blendSpeed = Math.min(1, dtMs / 140);
      lowerFaceBlendRef.current = MathUtils.lerp(lowerFaceBlendRef.current, 1, blendSpeed);
    }
    const lowerBlend = lowerFaceBlendRef.current;

    // ══════════════════════════════════════════════════════════════
    //  §7  UPPER-FACE-FIRST EMOTION
    // ══════════════════════════════════════════════════════════════
    // During calibration, always show the active emotion (even when idle/not speaking)
    const emotionPreset = (status === "speaking" || calibrationMode)
      ? (EMOTIONS[currentEmotion] || EMOTIONS.neutral)
      : EMOTIONS.neutral;

    const upperAttackSpeed = Math.min(1, dtMs / 120);
    const upperReleaseSpeed = Math.min(1, dtMs / 180);
    const lowerSpeed = Math.min(1, dtMs / 140);

    for (const shape of ALL_EMOTION_SHAPES) {
      const target = emotionPreset[shape] || 0;
      const isLower = LOWER_FACE_EMOTION_CHANNELS.has(shape);

      if (isLower) {
        if (speechActive) {
          setMorphTarget(shape, 0);
        } else {
          lerpMorphTarget(shape, target * lowerBlend, lowerSpeed);
        }
      } else {
        const speed = target > getCurrent(shape) ? upperAttackSpeed : upperReleaseSpeed;
        lerpMorphTarget(shape, target, speed);
      }
    }

    // ── Micro-saccades (enhanced with wider range during idle) ──
    const saccade = saccadeRef.current;
    if (now > saccade.nextTime) {
      const isThinking = currentEmotion === 'thinking';
      const isIdle = status !== 'speaking';
      // Wider saccades when idle (more natural "looking around")
      const rangeX = isIdle ? 0.09 : 0.06;
      const rangeY = isIdle ? 0.06 : 0.04;
      saccade.x = (Math.random() - 0.5) * rangeX;
      saccade.y = (Math.random() - 0.5) * rangeY;
      saccade.nextTime = now + (isThinking ? 300 + Math.random() * 400 : 600 + Math.random() * 1200);
    }
    if (currentEmotion !== 'thinking') {
      lerpMorphTarget("eyeLookInLeft", Math.max(0, saccade.x), 0.06);
      lerpMorphTarget("eyeLookOutLeft", Math.max(0, -saccade.x), 0.06);
      lerpMorphTarget("eyeLookInRight", Math.max(0, -saccade.x), 0.06);
      lerpMorphTarget("eyeLookOutRight", Math.max(0, saccade.x), 0.06);
      lerpMorphTarget("eyeLookUpLeft", Math.max(0, saccade.y), 0.06);
      lerpMorphTarget("eyeLookUpRight", Math.max(0, saccade.y), 0.06);
      lerpMorphTarget("eyeLookDownLeft", Math.max(0, -saccade.y), 0.06);
      lerpMorphTarget("eyeLookDownRight", Math.max(0, -saccade.y), 0.06);
    }

    // ── Neck: emotion tilt + subtle drift (conversation only) ──
    if (neckBoneRef.current) {
      const isSpeakingOrCalib = status === 'speaking' || calibrationMode;

      // Emotion-driven neck tilt
      let targetTilt = 0;
      if (isSpeakingOrCalib && currentEmotion === 'curious') targetTilt = 0.18;
      else if (isSpeakingOrCalib && currentEmotion === 'thinking') targetTilt = -0.10;

      // Micro head drift only during active conversation (not on startup screen)
      let driftX = 0, driftY = 0;
      if (isSpeakingOrCalib) {
        const drift = headDriftRef.current;
        if (now > drift.nextTime) {
          drift.targetX = (Math.random() - 0.5) * 0.02;
          drift.targetY = (Math.random() - 0.5) * 0.015;
          drift.nextTime = now + 2000 + Math.random() * 3000;
        }
        drift.x = MathUtils.lerp(drift.x, drift.targetX, 0.02);
        drift.y = MathUtils.lerp(drift.y, drift.targetY, 0.02);
        driftX = drift.x;
        driftY = drift.y;
      }

      // Only touch neck rotation during active conversation
      if (isSpeakingOrCalib) {
        neckBoneRef.current.rotation.z = MathUtils.lerp(neckBoneRef.current.rotation.z, targetTilt + driftX, 0.06);
        neckBoneRef.current.rotation.y = MathUtils.lerp(neckBoneRef.current.rotation.y, driftY, 0.04);
      }
    }

    // ── Tiny asymmetrical brow noise (idle humanization) ──
    const browNoise = browNoiseRef.current;
    if (now > browNoise.nextTime) {
      // Small random asymmetric brow movement
      browNoise.targetL = Math.random() * 0.06;
      browNoise.targetR = Math.random() * 0.06;
      browNoise.nextTime = now + 3000 + Math.random() * 5000;
    }
    browNoise.left = MathUtils.lerp(browNoise.left, browNoise.targetL, 0.03);
    browNoise.right = MathUtils.lerp(browNoise.right, browNoise.targetR, 0.03);
    // Only apply brow noise when no strong emotion is overriding
    if (!speechActive && currentEmotion === 'neutral') {
      lerpMorphTarget("browOuterUpLeft", browNoise.left, 0.04);
      lerpMorphTarget("browOuterUpRight", browNoise.right, 0.04);
    }

    // ══════════════════════════════════════════════════════════════
    //  §9  NATIVE-VISEME SPEECH MIXER
    // ══════════════════════════════════════════════════════════════
    if (status === "speaking") {
      if (speechActive) {
        // Use delayed weights if available, else fall back to current
        const weights = visemeReadyRef.current || currentWeights;

        if (weights) {
          // ── Step 1-2: Map phoneme classes to native visemes + apply caps ──
          const targetVisemes = {};
          const globalMult = calibrationTuning?.globalMultiplier ?? 1.15;
          const tunedCaps = calibrationTuning?.visemeMaxWeight;

          for (const [phoneme, visemeName] of Object.entries(PHONEME_TO_NATIVE_VISEME)) {
            let w = weights[phoneme] || 0;
            if (w < 0.01) continue;

            w = Math.min(1, w * globalMult);

            const cap = tunedCaps?.[visemeName] ?? VISEME_MAX_WEIGHT[visemeName] ?? 1.0;
            w = Math.min(w, cap);

            targetVisemes[visemeName] = (targetVisemes[visemeName] || 0) + w;
          }

          // ── Diphthong detection + transition ──
          // Check for dual-vowel patterns that indicate German diphthongs
          const wA = weights.A || 0, wE = weights.E || 0, wI = weights.I || 0;
          const wO = weights.O || 0, wU = weights.U || 0;
          const diph = diphthongRef.current;

          let diphMatch = null;
          if (wA > 0.2 && wI > 0.12) diphMatch = DIPHTHONGS.ei;       // ei/ai
          else if (wA > 0.2 && wU > 0.12) diphMatch = DIPHTHONGS.au;  // au
          else if (wO > 0.15 && wI > 0.12) diphMatch = DIPHTHONGS.eu; // eu/äu

          if (diphMatch) {
            if (!diph.active || diph.active !== diphMatch) {
              diph.active = diphMatch;
              diph.startTime = now;
            }
            const elapsed = now - diph.startTime;
            const progress = MathUtils.clamp(elapsed / diphMatch.durationMs, 0, 1);
            // Bias first component: at progress=0 → full 'from', at progress=1 → full 'to'
            const fromWeight = (1 - progress) * diphMatch.bias;
            const toWeight = progress * (1 - diphMatch.bias + 0.4); // slightly boost second
            const totalVowelEnergy = Math.max(wA, wE, wI, wO, wU) * globalMult;
            // Override the individual vowel visemes with diphthong blend
            const fromCap = tunedCaps?.[diphMatch.from] ?? VISEME_MAX_WEIGHT[diphMatch.from] ?? 1.0;
            const toCap = tunedCaps?.[diphMatch.to] ?? VISEME_MAX_WEIGHT[diphMatch.to] ?? 1.0;
            targetVisemes[diphMatch.from] = Math.min(totalVowelEnergy * fromWeight, fromCap);
            targetVisemes[diphMatch.to] = Math.min(totalVowelEnergy * toWeight, toCap);
          } else {
            diph.active = null;
          }

          // Detect bilabial candidate: consonant energy with no vowel
          const maxVowelW = Math.max(
            weights.A || 0, weights.E || 0, weights.I || 0,
            weights.O || 0, weights.U || 0
          );
          const consS = weights.S || 0;
          if (amplitude > 0.03 && maxVowelW < 0.08 && consS > 0.55) {
            targetVisemes['viseme_PP'] = Math.max(
              targetVisemes['viseme_PP'] || 0,
              Math.min(consS, tunedCaps?.viseme_PP ?? VISEME_MAX_WEIGHT.viseme_PP)
            );
          }

          // ── §2: PP onset boost + hold ──
          const rawPP = targetVisemes['viseme_PP'] || 0;
          const wasPPActive = now < ppHoldUntilRef.current;

          if (rawPP > 0.15) {
            // PP is active this frame
            if (!wasPPActive) {
              // First frame of PP onset — apply boost
              ppOnsetFrameRef.current = true;
              targetVisemes['viseme_PP'] = Math.min(1.0, rawPP + PP_ONSET_BOOST);
            }
            // Extend hold timer
            ppHoldUntilRef.current = Math.max(ppHoldUntilRef.current, now + PP_HOLD_MS);
          } else if (wasPPActive) {
            // Inside hold window — maintain PP at previous level
            targetVisemes['viseme_PP'] = prevVisemeWeightsRef.current['viseme_PP'] || rawPP;
          } else {
            ppOnsetFrameRef.current = false;
          }

          const ppActive = (targetVisemes['viseme_PP'] || 0) > 0.15 || now < ppHoldUntilRef.current;

          // ── Step 3: Crossfade — lerp from previous frame's viseme state ──
          const crossfadeSpeed = calibrationTuning?.crossfadeSpeed ?? 0.55;
          const prevWeights = prevVisemeWeightsRef.current;

          // Fricative fast-release: SS and CH decay faster when dropping
          const FRICATIVE_RELEASE_SPEED = 0.75; // faster than normal crossfade

          for (const viseme of NATIVE_VISEMES) {
            const target = MathUtils.clamp(targetVisemes[viseme] || 0, 0, 1);
            const prev = prevWeights[viseme] || 0;
            // Use faster release for fricatives to prevent visual sticking
            const isFricativeRelease = (viseme === 'viseme_SS' || viseme === 'viseme_CH') && target < prev;
            const speed = isFricativeRelease ? FRICATIVE_RELEASE_SPEED : crossfadeSpeed;
            const blended = MathUtils.lerp(prev, target, speed);
            lerpMorphTarget(viseme, blended, 0.7);
            prevWeights[viseme] = blended;
          }

          // ── §5: Hard clamp mouthClose ──
          // Only allow mouthClose during explicit PP, capped at PP_MOUTHCLOSE_MAX
          if (ppActive) {
            const ppW = targetVisemes['viseme_PP'] || 0;
            const assist = Math.min(ppW * 0.06, PP_MOUTHCLOSE_MAX);
            lerpMorphTarget("mouthClose", assist, 0.7);
          } else {
            setMorphTarget("mouthClose", 0.0);
          }

          // ── Step 4: ZERO all banned channels ──
          for (const banned of BANNED_DURING_SPEECH) {
            setMorphTarget(banned, 0.0);
          }

          // Also zero lower-face emotion mouth shapes during speech
          setMorphTarget("mouthSmileLeft", 0.0);
          setMorphTarget("mouthSmileRight", 0.0);
          setMorphTarget("mouthSmile", 0.0);
          setMorphTarget("mouthFrownLeft", 0.0);
          setMorphTarget("mouthFrownRight", 0.0);

          // Zero any ARKit mouth shapes NOT explicitly driven
          // (catches anything that might have leaked from idle/emotion)
          for (const shape of ARKIT_MOUTH_SHAPES) {
            if (shape === "mouthClose") continue; // driven by bilabial assist
            if (BANNED_DURING_SPEECH.has(shape)) continue; // already zeroed above
            if (LOWER_FACE_EMOTION_CHANNELS.has(shape)) continue; // handled by emotion system
            // Decay non-driven ARKit mouth shapes
            lerpMorphTarget(shape, 0, 0.6);
          }

        } else {
          // No weights available — decay all visemes
          for (const v of NATIVE_VISEMES) lerpMorphTarget(v, 0, 0.5);
          for (const shape of ARKIT_MOUTH_SHAPES) lerpMorphTarget(shape, 0, 0.5);
        }

      } else {
        // ── Silence during speaking status — snap mouth shut ──
        for (const v of NATIVE_VISEMES) lerpMorphTarget(v, 0, 1.0);
        for (const shape of ARKIT_MOUTH_SHAPES) lerpMorphTarget(shape, 0, 1.0);
        prevVisemeWeightsRef.current = {};

        // Gentle rest smile during pauses (gated by lowerBlend)
        const restSmile = 0.15 * lowerBlend;
        lerpMorphTarget("mouthSmileLeft", restSmile, 0.15);
        lerpMorphTarget("mouthSmileRight", restSmile, 0.15);
      }

    } else {
      // ══════════════════════════════════════════════════════════════
      //  NOT SPEAKING — friendly idle (skip idle smile during calibration
      //  so emotion presets like empathetic frown aren't overwritten)
      // ══════════════════════════════════════════════════════════════
      for (const v of NATIVE_VISEMES) lerpMorphTarget(v, 0, 0.15);
      prevVisemeWeightsRef.current = {};

      if (calibrationMode && currentEmotion !== 'neutral') {
        // During calibration emotion cycling: only zero non-emotion mouth shapes
        for (const shape of ARKIT_MOUTH_SHAPES) {
          if (!LOWER_FACE_EMOTION_CHANNELS.has(shape)) {
            lerpMorphTarget(shape, 0, 0.15);
          }
        }
      } else {
        for (const shape of ARKIT_MOUTH_SHAPES) lerpMorphTarget(shape, 0, 0.15);
        lerpMorphTarget("mouthSmileLeft", 0.3, 0.1);
        lerpMorphTarget("mouthSmileRight", 0.3, 0.1);
        lerpMorphTarget("mouthSmile", 0.2, 0.1);
        lerpMorphTarget("cheekSquintLeft", 0.1, 0.08);
        lerpMorphTarget("cheekSquintRight", 0.1, 0.08);
      }
    }

    // ══════════════════════════════════════════════════════════════
    //  §10 ASSERTIONS + DEBUG OUTPUT
    // ══════════════════════════════════════════════════════════════

    // Hard assertions (log once per type)
    if (speechActive) {
      if (getCurrent('tongueOut') > 0.001 && !window._assert_tongueOut) {
        console.error('[ASSERT] tongueOut > 0 during speech'); window._assert_tongueOut = true;
      }
      if (getCurrent('mouthRollLower') > 0.001 && !window._assert_rollLower) {
        console.error('[ASSERT] mouthRollLower > 0 during speech'); window._assert_rollLower = true;
      }
      if (getCurrent('mouthPucker') > 0.001 && !window._assert_pucker) {
        console.error('[ASSERT] mouthPucker > 0 during speech'); window._assert_pucker = true;
      }
      if (getCurrent('mouthFunnel') > 0.001 && !window._assert_funnel) {
        console.error('[ASSERT] mouthFunnel > 0 during speech'); window._assert_funnel = true;
      }
    }

    // Debug log (1/sec)
    if (!window._lipsyncDebugTimer || now - window._lipsyncDebugTimer > 1000) {
      window._lipsyncDebugTimer = now;

      // Dominant viseme
      let dominantViseme = 'viseme_sil';
      let dominantWeight = 0;
      for (const v of NATIVE_VISEMES) {
        const w = getCurrent(v);
        if (w > dominantWeight) { dominantWeight = w; dominantViseme = v; }
      }

      const effectiveOffset = visemeReadyRef.current ? VISUAL_SPEECH_OFFSET_MS : 0;

      const dbg = {
        speechActive,
        rmsAmplitude: amplitude.toFixed(4),
        phonemeConfidence: phonemeConfidence.toFixed(3),
        emotion: currentEmotion,
        emotionSwitchCount: emotionSwitchCountRef.current,
        lowerBlend: lowerBlend.toFixed(2),
        // Native viseme state
        dominantViseme,
        dominantVisemeWeight: dominantWeight.toFixed(3),
        // Per-viseme readout
        v_PP: getCurrent('viseme_PP').toFixed(3),
        v_FF: getCurrent('viseme_FF').toFixed(3),
        v_DD: getCurrent('viseme_DD').toFixed(3),
        v_kk: getCurrent('viseme_kk').toFixed(3),
        v_CH: getCurrent('viseme_CH').toFixed(3),
        v_SS: getCurrent('viseme_SS').toFixed(3),
        v_nn: getCurrent('viseme_nn').toFixed(3),
        v_RR: getCurrent('viseme_RR').toFixed(3),
        v_aa: getCurrent('viseme_aa').toFixed(3),
        v_E: getCurrent('viseme_E').toFixed(3),
        v_I: getCurrent('viseme_I').toFixed(3),
        v_O: getCurrent('viseme_O').toFixed(3),
        v_U: getCurrent('viseme_U').toFixed(3),
        // Banned channel verification
        mouthPucker: getCurrent('mouthPucker').toFixed(3),
        mouthFunnel: getCurrent('mouthFunnel').toFixed(3),
        mouthRollLower: getCurrent('mouthRollLower').toFixed(3),
        tongueOut: getCurrent('tongueOut').toFixed(3),
        mouthClose: getCurrent('mouthClose').toFixed(3),
        // Upper-face emotion readout
        browInnerUp: getCurrent('browInnerUp').toFixed(3),
        browDownL: getCurrent('browDownLeft').toFixed(3),
        eyeSquintL: getCurrent('eyeSquintLeft').toFixed(3),
        cheekSquintL: getCurrent('cheekSquintLeft').toFixed(3),
        // Timing
        audioClockTime: now.toFixed(0),
        visemeClockTime: targetVisemeTime.toFixed(0),
        effectiveVisemeOffsetMs: effectiveOffset,
        activeEmotionTag: currentEmotion,
      };
      debugRef.current = dbg;
      console.log('[LipSync v5 native]', dbg);

      // Push to store for calibration overlay (every 1sec snapshot)
      if (calibrationMode) {
        useAIStore.getState().setCalibrationDebugData(dbg);
        if (speechActive) {
          useAIStore.getState().pushCalibrationFrame({ ...dbg, t: now });
        }
      }
    }

    // High-frequency calibration debug (every 200ms when calibrating + speaking)
    if (calibrationMode && speechActive && (!window._calibFastTimer || now - window._calibFastTimer > 200)) {
      window._calibFastTimer = now;
      let domV = 'viseme_sil', domW = 0;
      for (const v of NATIVE_VISEMES) { const w = getCurrent(v); if (w > domW) { domW = w; domV = v; } }
      useAIStore.getState().setCalibrationDebugData({
        speechActive, dominantViseme: domV, dominantVisemeWeight: domW.toFixed(3),
        emotion: currentEmotion,
        v_PP: getCurrent('viseme_PP').toFixed(3), v_FF: getCurrent('viseme_FF').toFixed(3),
        v_DD: getCurrent('viseme_DD').toFixed(3), v_kk: getCurrent('viseme_kk').toFixed(3),
        v_CH: getCurrent('viseme_CH').toFixed(3), v_SS: getCurrent('viseme_SS').toFixed(3),
        v_nn: getCurrent('viseme_nn').toFixed(3), v_RR: getCurrent('viseme_RR').toFixed(3),
        v_aa: getCurrent('viseme_aa').toFixed(3), v_E: getCurrent('viseme_E').toFixed(3),
        v_I: getCurrent('viseme_I').toFixed(3), v_O: getCurrent('viseme_O').toFixed(3),
        v_U: getCurrent('viseme_U').toFixed(3),
        mouthPucker: getCurrent('mouthPucker').toFixed(3), mouthFunnel: getCurrent('mouthFunnel').toFixed(3),
        mouthClose: getCurrent('mouthClose').toFixed(3), tongueOut: getCurrent('tongueOut').toFixed(3),
        browInnerUp: getCurrent('browInnerUp').toFixed(3), cheekSquintL: getCurrent('cheekSquintLeft').toFixed(3),
      });
    }
  });

  return (
    <group ref={group} {...restProps} dispose={null} visible={ready}>
      <primitive object={scene} />
    </group>
  );
}

useGLTF.preload("/models/AvaturnAvatar.glb");
