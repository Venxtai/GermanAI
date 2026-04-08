import { useEffect, useRef, useState, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF, useAnimations } from "@react-three/drei";
import { MathUtils } from "three";
import { randInt } from "three/src/math/MathUtils";
import useAIStore from "../store/useAIStore";

/**
 * Hybrid lip sync + emotional expressions for Avaturn avatar.
 *
 * Lip sync: viseme timeline (phoneme shapes) × audio amplitude (timing gate).
 * Emotions: detected from speaking text, drives brows/eyes/cheeks.
 * Idle: friendly smile + gentle eye movements.
 */

// All Oculus visemes
const ALL_VISEMES = [
  "viseme_sil", "viseme_PP", "viseme_FF", "viseme_TH",
  "viseme_DD", "viseme_kk", "viseme_CH", "viseme_SS",
  "viseme_nn", "viseme_RR", "viseme_aa", "viseme_E",
  "viseme_I", "viseme_O", "viseme_U",
];

// All ARKit mouth shapes
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

// Emotional blend shapes (brows, eyes, cheeks)
const EMOTION_SHAPES = [
  "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
  "eyeWideLeft", "eyeWideRight", "eyeSquintLeft", "eyeSquintRight",
  "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight",
  "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
  "cheekSquintLeft", "cheekSquintRight", "cheekPuff",
  "noseSneerLeft", "noseSneerRight",
  "mouthSmileLeft", "mouthSmileRight", "mouthSmile",
  "mouthFrownLeft", "mouthFrownRight",
  "mouthPucker", "mouthRollLower", "mouthOpen",
  "jawForward",
];

/**
 * VISEME → ARKit blend shapes. Strong, differentiated poses.
 * These are FULL values — gated by audio amplitude for timing.
 */
const VISEME_TO_ARKIT = {
  viseme_sil: {},

  // P, B, M — lips pressed (bilabial)
  viseme_PP: {
    mouthClose: 0.55, mouthPressLeft: 0.4, mouthPressRight: 0.4,
    mouthRollUpper: 0.1, mouthRollLower: 0.1, jawOpen: 0.02,
  },

  // F, V, W — lower lip under upper teeth (labiodental)
  viseme_FF: {
    mouthFunnel: 0.15, mouthUpperUpLeft: 0.2, mouthUpperUpRight: 0.2,
    mouthLowerDownLeft: 0.15, mouthLowerDownRight: 0.15,
    mouthRollLower: 0.35, jawOpen: 0.08, mouthPucker: 0.1,
  },

  // TH — tongue between teeth
  viseme_TH: {
    tongueOut: 0.5, jawOpen: 0.15, mouthOpen: 0.15,
    mouthUpperUpLeft: 0.1, mouthUpperUpRight: 0.1,
  },

  // T, D — tongue behind teeth
  viseme_DD: {
    jawOpen: 0.15, mouthOpen: 0.1,
    mouthUpperUpLeft: 0.1, mouthUpperUpRight: 0.1, mouthShrugUpper: 0.1,
  },

  // K, G — back throat
  viseme_kk: {
    jawOpen: 0.2, mouthOpen: 0.12,
    mouthStretchLeft: 0.08, mouthStretchRight: 0.08,
  },

  // CH, SCH, J — rounded/forward
  viseme_CH: {
    jawOpen: 0.12, mouthFunnel: 0.35, mouthPucker: 0.25,
    mouthShrugUpper: 0.15, mouthShrugLower: 0.1,
  },

  // S, Z — teeth close, wide
  viseme_SS: {
    jawOpen: 0.06, mouthStretchLeft: 0.3, mouthStretchRight: 0.3,
    mouthClose: 0.25, mouthShrugUpper: 0.15,
  },

  // N, L — tongue on ridge, slight lateral tension
  viseme_nn: {
    jawOpen: 0.1, mouthOpen: 0.05,
    mouthStretchLeft: 0.18, mouthStretchRight: 0.18,
    mouthShrugUpper: 0.08,
  },

  // R — slight rounding
  viseme_RR: {
    jawOpen: 0.15, mouthOpen: 0.1, mouthFunnel: 0.15, mouthPucker: 0.08,
  },

  // AH — wide open (a, ä)
  viseme_aa: {
    jawOpen: 0.45, mouthOpen: 0.4,
    mouthLowerDownLeft: 0.3, mouthLowerDownRight: 0.3,
    mouthUpperUpLeft: 0.15, mouthUpperUpRight: 0.15,
  },

  // EH — medium open, wide (e)
  viseme_E: {
    jawOpen: 0.22, mouthOpen: 0.18,
    mouthStretchLeft: 0.35, mouthStretchRight: 0.35,
    mouthDimpleLeft: 0.1, mouthDimpleRight: 0.1,
  },

  // EE — narrow, very wide (i, ie)
  viseme_I: {
    jawOpen: 0.12, mouthOpen: 0.08,
    mouthStretchLeft: 0.45, mouthStretchRight: 0.45,
    mouthDimpleLeft: 0.15, mouthDimpleRight: 0.15,
  },

  // OH — rounded, medium open (o, ö) — strong puckering for German Umlaute
  viseme_O: {
    jawOpen: 0.35, mouthOpen: 0.3,
    mouthFunnel: 0.65, mouthPucker: 0.6,
    mouthRollLower: 0.15,
  },

  // OO — very rounded, small opening (u, ü) — maximum lip rounding for German Umlaute
  viseme_U: {
    jawOpen: 0.18, mouthOpen: 0.12,
    mouthFunnel: 0.75, mouthPucker: 0.75,
    mouthRollLower: 0.2,
  },
};

/**
 * Emotion presets — drive brows, eyes, cheeks for facial expression.
 * Blended on top of lip sync.
 */
const EMOTIONS = {
  neutral: {
    eyeSquintLeft: 0.05, eyeSquintRight: 0.05,
    browInnerUp: 0.0,
  },
  happy: {
    mouthSmileLeft: 0.6, mouthSmileRight: 0.6,
    eyeSquintLeft: 0.5, eyeSquintRight: 0.5,
    cheekSquintLeft: 0.25, cheekSquintRight: 0.25,
  },
  excited: {
    browInnerUp: 0.5,
    eyeWideLeft: 0.5, eyeWideRight: 0.5,
    mouthSmileLeft: 0.85, mouthSmileRight: 0.85,
    cheekSquintLeft: 0.4, cheekSquintRight: 0.4,
  },
  curious: {
    browOuterUpLeft: 1.0, browDownRight: 0.4,
    eyeWideLeft: 0.3,
    mouthPucker: 0.1,
  },
  empathetic: {
    browInnerUp: 0.7,
    eyeSquintLeft: 0.35, eyeSquintRight: 0.35,
    mouthSmileLeft: 0.2, mouthSmileRight: 0.2,
    jawForward: 0.1,
  },
  thinking: {
    browOuterUpLeft: 0.6, browInnerUp: 0.2,
    eyeLookUpLeft: 0.5, eyeLookInRight: 0.5,  // Lateral gaze — upper-left to simulate cognitive recall
    mouthPucker: 0.2,
  },
  surprised: {
    browInnerUp: 0.9,
    eyeWideLeft: 0.7, eyeWideRight: 0.7,
  },
  concerned: {
    browInnerUp: 0.6,
    browDownLeft: 0.3, browDownRight: 0.3,
    mouthFrownLeft: 0.5, mouthFrownRight: 0.5,
  },
};

// Keyword-based emotion detection from German text
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

/**
 * wLipSync phoneme → VISEME_TO_ARKIT mapping.
 * wLipSync outputs weights for: A, I, U, E, O, S
 */
const PHONEME_TO_VISEME = {
  A: "viseme_aa",
  E: "viseme_E",
  I: "viseme_I",
  O: "viseme_O",
  U: "viseme_U",
  S: "viseme_SS",
};

/**
 * Detect emotion from German text.
 */
function detectEmotion(text) {
  if (!text) return "neutral";
  const lower = text.toLowerCase();

  // Check question marks → curious
  if (lower.includes("?")) {
    // But check if it's also happy/excited
    for (const word of EMOTION_KEYWORDS.excited) {
      if (lower.includes(word)) return "excited";
    }
    return "curious";
  }

  // Check exclamation → excited or happy
  const hasExclamation = lower.includes("!");

  // Score each emotion
  let bestEmotion = "neutral";
  let bestScore = 0;

  for (const [emotion, keywords] of Object.entries(EMOTION_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (lower.includes(keyword)) score++;
    }
    if (hasExclamation && (emotion === "happy" || emotion === "excited")) {
      score += 0.5;
    }
    if (score > bestScore) {
      bestScore = score;
      bestEmotion = emotion;
    }
  }

  return bestScore > 0 ? bestEmotion : "neutral";
}

export function Character(props) {
  const group = useRef();

  const { scene, animations } = useGLTF("/models/AvaturnAvatar.glb");
  const { actions } = useAnimations(animations, scene);

  const [blink, setBlink] = useState(false);
  const [ready, setReady] = useState(false); // Hide until animation starts (avoid T-pose flash)

  const status             = useAIStore((s) => s.status);
  const analyzerNode       = useAIStore((s) => s.analyzerNode);
  const lipsyncNode        = useAIStore((s) => s.lipsyncNode);
  const currentEmotion     = useAIStore((s) => s.currentEmotion);
  const emotionTimeline    = useAIStore((s) => s.emotionTimeline);
  const emotionPlaybackStart = useAIStore((s) => s.emotionPlaybackStart);
  const emotionAudioDuration = useAIStore((s) => s.emotionAudioDuration);
  const setCurrentEmotion  = useAIStore((s) => s.setCurrentEmotion);

  const freqDataRef = useRef(null);
  const neckBoneRef = useRef(null);
  const saccadeRef = useRef({ x: 0, y: 0, nextTime: 0 }); // micro-saccade state

  // Fix PBR materials and assign avatar to lighting layer.
  // Avaturn exports metallicRoughness textures that make skin/clothes behave
  // like metal (ignoring directional lights). Remove metalness maps so lights work.
  // Also enable avatarLayer so avatar-only lights in Experience.jsx affect her.
  const { avatarLayer, ...restProps } = props;
  useEffect(() => {
    // Find neck bone for head tilt during curious emotion
    scene.traverse((child) => {
      if (child.isBone && (child.name === 'Neck' || child.name === 'neck')) {
        neckBoneRef.current = child;
      }
    });

    scene.traverse((child) => {
      // Put all avatar meshes on the avatar lighting layer
      if (avatarLayer !== undefined && child.isMesh) {
        child.layers.enable(avatarLayer);
      }
      if (child.material) {
        const mat = child.material;
        const name = (mat.name || "").toLowerCase();

        // Glasses lens — keep reflective
        if (name.includes("glasses_1")) return;

        // Remove metalness map so scalar value takes effect
        if (mat.metalnessMap) {
          mat.metalnessMap = null;
        }

        // Non-metallic (skin, clothes, hair are dielectric)
        mat.metalness = 0;

        // Reset color to white (in case it was tinted by previous test)
        if (mat.color) mat.color.set(0xffffff);

        // Keep roughness maps for surface detail
        mat.needsUpdate = true;
      }
    });
  }, [scene]);

  // Play idle animation (breathing only — strip morph tracks, trim before head-turning).
  useEffect(() => {
    if (animations && animations.length > 0) {
      const clip = animations[0];
      // Remove morph target tracks (we drive face/mouth ourselves)
      // Remove Neck bone tracks (we drive neck tilt for emotions)
      clip.tracks = clip.tracks.filter(
        (track) => !track.name.includes("morphTargetInfluences") && !track.name.includes("Neck")
      );
      // Trim to 3.3s — one full breathing cycle
      clip.duration = 3.3;
    }
    if (actions && Object.keys(actions).length > 0) {
      const firstAction = Object.values(actions)[0];
      if (firstAction) {
        firstAction.reset().setLoop(2202, Infinity).play(); // THREE.LoopPingPong = 2202 (forward then backward = seamless)
        setReady(true);
      }
    }
  }, [actions, animations]);

  // Blink loop
  useEffect(() => {
    let blinkTimeout;
    const nextBlink = () => {
      blinkTimeout = setTimeout(() => {
        setBlink(true);
        setTimeout(() => {
          setBlink(false);
          nextBlink();
        }, randInt(80, 150)); // Vary blink duration too
      }, Math.random() * 3000 + 3000); // 3-6s, truly random (not integer-stepped)
    };
    nextBlink();
    return () => clearTimeout(blinkTimeout);
  }, []);

  // Lerp a morph target across all skinned meshes
  const lerpMorphTarget = (targetName, value, speed = 0.1) => {
    scene.traverse((child) => {
      if (child.isSkinnedMesh && child.morphTargetDictionary) {
        const index = child.morphTargetDictionary[targetName];
        if (index === undefined || child.morphTargetInfluences[index] === undefined) return;
        child.morphTargetInfluences[index] = MathUtils.lerp(
          child.morphTargetInfluences[index],
          value,
          speed
        );
      }
    });
  };

  // Get current value of a morph target
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

  // Audio amplitude from AnalyserNode (0-1)
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

  // Per-frame update
  useFrame(() => {
    // ── Blink ──
    lerpMorphTarget("eyeBlinkLeft", blink ? 1 : 0, 0.5);
    lerpMorphTarget("eyeBlinkRight", blink ? 1 : 0, 0.5);

    // ── Update emotion from timeline based on playback progress ──
    if (status === "speaking" && emotionTimeline && emotionTimeline.length > 1 && emotionPlaybackStart && emotionAudioDuration > 0) {
      const elapsed = (performance.now() - emotionPlaybackStart) / 1000;
      const progress = MathUtils.clamp(elapsed / emotionAudioDuration, 0, 1);
      // Find the active segment (last one whose start <= progress)
      let activeEmotion = emotionTimeline[0].emotion;
      for (let i = emotionTimeline.length - 1; i >= 0; i--) {
        if (progress >= emotionTimeline[i].start) {
          activeEmotion = emotionTimeline[i].emotion;
          break;
        }
      }
      if (activeEmotion !== currentEmotion) {
        setCurrentEmotion(activeEmotion);
      }
    }

    // ── Emotional expression (smooth ~250ms transitions to avoid "snap") ──
    const emotionPreset = status === "speaking"
      ? (EMOTIONS[currentEmotion] || EMOTIONS.neutral)
      : EMOTIONS.neutral;
    const emotionLerp = 0.08; // ~250ms transition at 60fps — organic, not snappy

    // During speaking, lip sync gets 100% exclusive control over ALL mouth/jaw geometry.
    // Emotions only drive the upper face (brows, eyes, cheeks, head tilt).
    const isMouthShape = (s) => s.startsWith("mouth") || s.startsWith("jaw") || s === "tongueOut" || s === "cheekPuff";

    for (const [shape, target] of Object.entries(emotionPreset)) {
      if (status === "speaking" && isMouthShape(shape)) continue;
      lerpMorphTarget(shape, target, emotionLerp);
    }
    // Reset emotion shapes not in current preset
    for (const shape of EMOTION_SHAPES) {
      if (!(shape in emotionPreset)) {
        if (status === "speaking" && isMouthShape(shape)) continue;
        lerpMorphTarget(shape, 0, emotionLerp);
      }
    }

    // ── Micro-saccades — subtle eye movements (faster during THINKING) ──
    const now = performance.now();
    const saccade = saccadeRef.current;
    if (now > saccade.nextTime) {
      const isThinking = currentEmotion === 'thinking';
      saccade.x = (Math.random() - 0.5) * 0.06;
      saccade.y = (Math.random() - 0.5) * 0.04;
      saccade.nextTime = now + (isThinking ? 300 + Math.random() * 400 : 800 + Math.random() * 1500);
    }
    // Don't override eye look directions that THINKING emotion controls (eyeLookUpLeft, eyeLookInRight)
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

    // Neck tilt — "social tilt" for curious, reset for others
    if (neckBoneRef.current) {
      const targetTilt = (status === 'speaking' && currentEmotion === 'curious') ? 0.15 : 0;
      neckBoneRef.current.rotation.z = MathUtils.lerp(neckBoneRef.current.rotation.z, targetTilt, 0.12);
    }

    if (status === "speaking") {
      // ── wLipSync mode: real-time phoneme weights from audio analysis ──
      const amplitude = getAudioAmplitude();

      // Debug: log once per second
      if (!window._lipsyncDebugTimer || Date.now() - window._lipsyncDebugTimer > 1000) {
        window._lipsyncDebugTimer = Date.now();
        console.log('[LipSync Debug]', {
          hasLipsyncNode: !!lipsyncNode,
          amplitude: amplitude.toFixed(3),
          weights: lipsyncNode?.weights,
          volume: lipsyncNode?.volume,
          emotion: currentEmotion,
        });
      }

      if (lipsyncNode && amplitude > 0.06) {
        const weights = lipsyncNode.weights; // { A: 0.0-1.0, I: ..., U: ..., E: ..., O: ..., S: ... }

        // Apply each phoneme's ARKit blend shape pose, weighted by phoneme strength
        // First, accumulate all ARKit shape targets from all active phonemes
        const arkitTargets = {};
        for (const [phoneme, visemeName] of Object.entries(PHONEME_TO_VISEME)) {
          let w = weights[phoneme] || 0;
          if (w < 0.01) continue;
          // Amplify O/U weights — wLipSync often under-detects rounded vowels,
          // but German needs strong puckering for ö/ü/o/u
          if (phoneme === 'O' || phoneme === 'U') w = Math.min(1, w * 1.8);
          const pose = VISEME_TO_ARKIT[visemeName];
          if (!pose) continue;
          for (const [shape, value] of Object.entries(pose)) {
            arkitTargets[shape] = (arkitTargets[shape] || 0) + value * w;
          }
        }

        // Apply accumulated ARKit targets — explosive shapes snap fast, vowels slightly slower
        const EXPLOSIVE_SHAPES = new Set([
          "mouthClose", "mouthPressLeft", "mouthPressRight",  // P, B, M
          "mouthShrugUpper", "tongueOut",                      // T, D, TH
        ]);
        for (const [shape, target] of Object.entries(arkitTargets)) {
          const speed = EXPLOSIVE_SHAPES.has(shape) ? 0.8 : 0.55;
          lerpMorphTarget(shape, MathUtils.clamp(target, 0, 1), speed);
        }

        // Reset ARKit mouth shapes not driven this frame — snap shut fast
        for (const shape of ARKIT_MOUTH_SHAPES) {
          if (!(shape in arkitTargets)) {
            lerpMorphTarget(shape, 0, 0.5);
          }
        }

        // Also reset Oculus viseme targets (not used in ARKit mode)
        for (const v of ALL_VISEMES) {
          lerpMorphTarget(v, 0, 0.3);
        }

        // Subtle smile while speaking
        const smileTarget = 0.03;
        lerpMorphTarget("mouthSmileLeft", smileTarget, 0.15);
        lerpMorphTarget("mouthSmileRight", smileTarget, 0.15);
      } else {
        // No lipsync node or silence — snap mouth shut instantly (no mumbling during pauses)
        for (const v of ALL_VISEMES) lerpMorphTarget(v, 0, 1.0);
        for (const shape of ARKIT_MOUTH_SHAPES) lerpMorphTarget(shape, 0, 1.0);

        const smileTarget = 0.15;
        lerpMorphTarget("mouthSmileLeft", smileTarget, 0.15);
        lerpMorphTarget("mouthSmileRight", smileTarget, 0.15);
      }

    } else {
      // ── NOT SPEAKING — reset mouth, show friendly smile ──
      for (const v of ALL_VISEMES) lerpMorphTarget(v, 0, 0.15);
      for (const shape of ARKIT_MOUTH_SHAPES) lerpMorphTarget(shape, 0, 0.15);

      // Friendly idle smile
      lerpMorphTarget("mouthSmileLeft", 0.3, 0.1);
      lerpMorphTarget("mouthSmileRight", 0.3, 0.1);
      lerpMorphTarget("mouthSmile", 0.2, 0.1);
      lerpMorphTarget("cheekSquintLeft", 0.1, 0.08);
      lerpMorphTarget("cheekSquintRight", 0.1, 0.08);
    }
  });

  return (
    <group ref={group} {...restProps} dispose={null} visible={ready}>
      <primitive object={scene} />
    </group>
  );
}

useGLTF.preload("/models/AvaturnAvatar.glb");
