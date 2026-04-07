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
  "cheekSquintLeft", "cheekSquintRight", "cheekPuff",
  "noseSneerLeft", "noseSneerRight",
  "mouthSmileLeft", "mouthSmileRight", "mouthSmile",
  "mouthFrownLeft", "mouthFrownRight",
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

  // N, L — tongue on ridge
  viseme_nn: {
    jawOpen: 0.1, mouthOpen: 0.05,
    mouthStretchLeft: 0.12, mouthStretchRight: 0.12,
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

  // OH — rounded, medium open (o, ö)
  viseme_O: {
    jawOpen: 0.3, mouthOpen: 0.25,
    mouthFunnel: 0.45, mouthPucker: 0.3,
  },

  // OO — very rounded, small opening (u, ü)
  viseme_U: {
    jawOpen: 0.15, mouthOpen: 0.1,
    mouthFunnel: 0.55, mouthPucker: 0.5,
  },
};

/**
 * Emotion presets — drive brows, eyes, cheeks for facial expression.
 * Blended on top of lip sync.
 */
const EMOTIONS = {
  neutral: {
    browInnerUp: 0, browOuterUpLeft: 0, browOuterUpRight: 0,
    browDownLeft: 0, browDownRight: 0,
    eyeWideLeft: 0, eyeWideRight: 0,
    eyeSquintLeft: 0, eyeSquintRight: 0,
    cheekSquintLeft: 0, cheekSquintRight: 0,
    mouthSmileLeft: 0.2, mouthSmileRight: 0.2, mouthSmile: 0.15,
  },
  happy: {
    browInnerUp: 0.15, browOuterUpLeft: 0.2, browOuterUpRight: 0.2,
    eyeSquintLeft: 0.2, eyeSquintRight: 0.2,
    cheekSquintLeft: 0.25, cheekSquintRight: 0.25,
    mouthSmileLeft: 0.35, mouthSmileRight: 0.35, mouthSmile: 0.3,
  },
  excited: {
    browInnerUp: 0.3, browOuterUpLeft: 0.35, browOuterUpRight: 0.35,
    eyeWideLeft: 0.2, eyeWideRight: 0.2,
    cheekSquintLeft: 0.15, cheekSquintRight: 0.15,
    mouthSmileLeft: 0.4, mouthSmileRight: 0.4, mouthSmile: 0.3,
  },
  curious: {
    browInnerUp: 0.35, browOuterUpLeft: 0.15, browOuterUpRight: 0.3,
    eyeWideLeft: 0.1, eyeWideRight: 0.15,
    mouthSmileLeft: 0.1, mouthSmileRight: 0.1, mouthSmile: 0.05,
  },
  empathetic: {
    browInnerUp: 0.3, browDownLeft: 0.1, browDownRight: 0.1,
    eyeSquintLeft: 0.1, eyeSquintRight: 0.1,
    mouthSmileLeft: 0.15, mouthSmileRight: 0.15, mouthSmile: 0.1,
    mouthFrownLeft: 0.05, mouthFrownRight: 0.05,
  },
  thinking: {
    browInnerUp: 0.2, browOuterUpLeft: 0.1, browOuterUpRight: 0.25,
    eyeSquintLeft: 0.15, eyeSquintRight: 0.05,
    mouthSmileLeft: 0.08, mouthSmileRight: 0.08,
    mouthPucker: 0.05,
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
  ],
  thinking: [
    "hmm", "also", "vielleicht", "möglicherweise", "eigentlich",
    "ich denke", "ich glaube", "ich meine", "mal sehen", "lass mich",
    "überlegen", "moment",
  ],
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

  const status          = useAIStore((s) => s.status);
  const analyzerNode    = useAIStore((s) => s.analyzerNode);
  const visemeTimeline  = useAIStore((s) => s.visemeTimeline);
  const visemeStartTime = useAIStore((s) => s.visemeStartTime);
  const speakingText    = useAIStore((s) => s.speakingText);

  const freqDataRef = useRef(null);
  const currentEmotionRef = useRef("neutral");
  const emotionBlendsRef = useRef({});

  // Detect emotion whenever speaking text changes
  useEffect(() => {
    if (speakingText) {
      currentEmotionRef.current = detectEmotion(speakingText);
    }
  }, [speakingText]);

  // Fix PBR materials and assign avatar to lighting layer.
  // Avaturn exports metallicRoughness textures that make skin/clothes behave
  // like metal (ignoring directional lights). Remove metalness maps so lights work.
  // Also enable avatarLayer so avatar-only lights in Experience.jsx affect her.
  const { avatarLayer, ...restProps } = props;
  useEffect(() => {
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
      clip.tracks = clip.tracks.filter(
        (track) => !track.name.includes("morphTargetInfluences")
      );
      // Trim to 3.3s — one full breathing cycle
      clip.duration = 3.3;
    }
    if (actions && Object.keys(actions).length > 0) {
      const firstAction = Object.values(actions)[0];
      if (firstAction) {
        firstAction.reset().setLoop(2202, Infinity).play(); // THREE.LoopPingPong = 2202 (forward then backward = seamless)
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
        }, 120);
      }, randInt(1500, 5000));
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

  // Current viseme from timeline using elapsed time
  const getCurrentViseme = () => {
    if (!visemeTimeline || visemeTimeline.length === 0 || !visemeStartTime) {
      return "viseme_sil";
    }
    const elapsed = (performance.now() - visemeStartTime) / 1000;
    for (let i = visemeTimeline.length - 1; i >= 0; i--) {
      const v = visemeTimeline[i];
      if (elapsed >= v.time && elapsed < v.time + v.duration) {
        return v.viseme;
      }
    }
    return "viseme_sil";
  };

  // Per-frame update
  useFrame(() => {
    // ── Blink ──
    lerpMorphTarget("eyeBlinkLeft", blink ? 1 : 0, 0.5);
    lerpMorphTarget("eyeBlinkRight", blink ? 1 : 0, 0.5);

    // ── Emotional expression (always active, changes slowly) ──
    const emotion = currentEmotionRef.current;
    const emotionPreset = status === "speaking"
      ? (EMOTIONS[emotion] || EMOTIONS.neutral)
      : EMOTIONS.neutral;

    // Lerp emotion shapes slowly for smooth transitions
    for (const [shape, target] of Object.entries(emotionPreset)) {
      // Don't drive smile shapes here during speaking — lip sync handles mouth
      if (status === "speaking" && shape.startsWith("mouthSmile")) continue;
      lerpMorphTarget(shape, target, 0.06);
    }
    // Reset emotion shapes not in current preset
    for (const shape of EMOTION_SHAPES) {
      if (!(shape in emotionPreset)) {
        if (status === "speaking" && shape.startsWith("mouthSmile")) continue;
        lerpMorphTarget(shape, 0, 0.06);
      }
    }

    if (status === "speaking") {
      const amplitude = getAudioAmplitude();
      const viseme = getCurrentViseme();

      // Audio gate: only fully close during clear silence, otherwise let shapes through
      let gate;
      if (amplitude < 0.015) {
        gate = 0;  // true silence
      } else if (amplitude < 0.06) {
        gate = (amplitude - 0.015) / 0.045;  // quick ramp up
      } else {
        gate = 1.0;  // full intensity — let the viseme shapes show clearly
      }

      // Use the model's built-in Oculus viseme shapes directly.
      // These are pre-sculpted by the artist for each phoneme and include
      // jaw, lips, tongue, and teeth movement all in one shape.
      // Much more accurate than manually combining ARKit shapes.

      // Reset all visemes toward 0, then activate the current one
      for (const v of ALL_VISEMES) {
        const target = (v === viseme && gate > 0) ? gate * 0.85 : 0;
        lerpMorphTarget(v, target, 0.3);
      }

      // Also drive jawOpen proportional to gate for natural movement
      lerpMorphTarget("jawOpen", gate > 0 ? gate * 0.15 : 0, 0.25);

      // Gentle smile during pauses
      const smileTarget = gate < 0.1 ? 0.15 : 0.03;
      lerpMorphTarget("mouthSmileLeft", smileTarget, 0.15);
      lerpMorphTarget("mouthSmileRight", smileTarget, 0.15);

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

      // Reset emotion to neutral when not speaking
      currentEmotionRef.current = "neutral";
    }
  });

  return (
    <group ref={group} {...restProps} dispose={null}>
      <primitive object={scene} />
    </group>
  );
}

useGLTF.preload("/models/AvaturnAvatar.glb");
