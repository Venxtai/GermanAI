import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { useAnimations, useGLTF } from "@react-three/drei";
import { MathUtils, LoopRepeat, LoopOnce } from "three";
import { randInt } from "three/src/math/MathUtils";
import useAIStore from "../store/useAIStore";

const ANIMATION_FADE_TIME = 0.5;

// All Oculus visemes used by the timeline system
const ALL_VISEMES = [
  "viseme_sil", "viseme_PP", "viseme_FF", "viseme_TH",
  "viseme_DD", "viseme_kk", "viseme_CH", "viseme_SS",
  "viseme_nn", "viseme_RR", "viseme_aa", "viseme_E",
  "viseme_I", "viseme_O", "viseme_U",
];

export function Character(props) {
  const group = useRef();

  // Load female avatar model + Mixamo animations (made for her skeleton)
  const { scene } = useGLTF("/models/FemaleAvatar.glb");
  const { animations: rawAnimations } = useGLTF("/models/animations_Female.glb");

  const animations = rawAnimations;

  const { actions, mixer } = useAnimations(animations, group);

  const [animation, setAnimation] = useState("Idle");
  const [blink, setBlink] = useState(false);
  const headBoneRef = useRef(null);
  const leftEyeBoneRef = useRef(null);
  const rightEyeBoneRef = useRef(null);

  const status         = useAIStore((s) => s.status);
  const analyzerNode   = useAIStore((s) => s.analyzerNode);
  const visemeTimeline = useAIStore((s) => s.visemeTimeline);
  const visemeStartTime = useAIStore((s) => s.visemeStartTime);
  const amplitudeDataRef = useRef(new Uint8Array(128));
  const isTalkingRef = useRef(false);
  const idleTimerRef = useRef(null);
  const isFirstSpeakRef = useRef(true);
  const currentVisemeRef = useRef({}); // { visemeName: targetWeight } for smooth lerping

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

  // Find Head and Eye bones for look-at rotation
  useEffect(() => {
    scene.traverse((child) => {
      if (child.isBone) {
        if (child.name === 'Head') headBoneRef.current = child;
        if (child.name === 'LeftEye') leftEyeBoneRef.current = child;
        if (child.name === 'RightEye') rightEyeBoneRef.current = child;
      }
    });
  }, [scene]);

  // Animation state based on AI status
  useEffect(() => {
    if (status === "loading") {
      clearTimeout(idleTimerRef.current);
      isTalkingRef.current = false;
      setAnimation("Idle");
    } else if (status === "speaking") {
      clearTimeout(idleTimerRef.current);
      if (!isTalkingRef.current) {
        isTalkingRef.current = true;
        if (isFirstSpeakRef.current) {
          // First time speaking — play greeting wave
          isFirstSpeakRef.current = false;
          setAnimation("Greeting");
        } else {
          setAnimation("Talking");
        }
      }
    } else {
      idleTimerRef.current = setTimeout(() => {
        isTalkingRef.current = false;
        setAnimation("Idle");
      }, 0);
    }
    return () => clearTimeout(idleTimerRef.current);
  }, [status]);

  // Crossfade to new animation
  useEffect(() => {
    if (!actions[animation]) return;

    const action = actions[animation];
    action.reset().fadeIn(mixer.time > 0 ? ANIMATION_FADE_TIME : 0);

    if (animation === "Greeting") {
      // Greeting plays once then transitions to Idle
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      const onFinished = () => {
        mixer.removeEventListener('finished', onFinished);
        setAnimation("Idle");
      };
      mixer.addEventListener('finished', onFinished);
    } else {
      action.setLoop(LoopRepeat, Infinity);
    }

    action.play();
    return () => {
      action.fadeOut(ANIMATION_FADE_TIME);
    };
  }, [animation, actions, mixer]);

  // Lerp a morph target by name
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

  // Per-frame: viseme-based lipsync + blink + smile
  // Priority 1 ensures this runs AFTER the animation mixer (priority 0)
  useFrame(() => {
    // Blink
    lerpMorphTarget("eyeBlinkLeft", blink ? 1 : 0, 0.5);
    lerpMorphTarget("eyeBlinkRight", blink ? 1 : 0, 0.5);

    // Subtle idle smile
    lerpMorphTarget("mouthSmileLeft", 0.15, 0.3);
    lerpMorphTarget("mouthSmileRight", 0.15, 0.3);


    // Eyelid openness (0.4 = natural relaxed look)
    lerpMorphTarget("eyesLookUp", 0.4, 0.1);

    if (status === "speaking" && visemeTimeline && visemeStartTime) {
      // ── VISEME TIMELINE MODE — phoneme-accurate mouth shapes ──
      const elapsed = (performance.now() - visemeStartTime) / 1000; // seconds

      // Find the current viseme in the timeline
      let activeViseme = "viseme_sil";
      let activeWeight = 0;
      for (let i = visemeTimeline.length - 1; i >= 0; i--) {
        const v = visemeTimeline[i];
        if (elapsed >= v.time && elapsed < v.time + v.duration) {
          activeViseme = v.viseme;
          activeWeight = v.weight || 0.6;
          break;
        }
        if (elapsed >= v.time + v.duration && i === visemeTimeline.length - 1) {
          // Past the last viseme — close mouth
          activeViseme = "viseme_sil";
          activeWeight = 0;
          break;
        }
      }

      // Build target weights: active viseme gets its weight, all others go to 0
      const targets = {};
      for (const v of ALL_VISEMES) {
        targets[v] = v === activeViseme ? activeWeight : 0;
      }

      // Also drive jawOpen proportional to open-mouth visemes
      const isOpenMouth = ["viseme_aa", "viseme_O", "viseme_E", "viseme_I", "viseme_U"].includes(activeViseme);
      targets["jawOpen"] = isOpenMouth ? activeWeight * 0.4 : 0;
      targets["mouthOpen"] = isOpenMouth ? activeWeight * 0.3 : 0;

      // Smooth lerp all targets
      for (const [name, target] of Object.entries(targets)) {
        lerpMorphTarget(name, target, 0.4);
      }

    } else if (status === "speaking") {
      // ── FALLBACK: amplitude-only mode (no viseme data) ──
      let audioEnergy = 0;
      if (analyzerNode) {
        analyzerNode.getByteFrequencyData(amplitudeDataRef.current);
        audioEnergy = amplitudeDataRef.current.slice(1, 15).reduce((a, b) => a + b, 0) / 14;
      }
      const mouthValue = MathUtils.clamp(audioEnergy / 150, 0, 0.5);
      lerpMorphTarget("viseme_aa", mouthValue > 0.03 ? mouthValue * 0.6 : 0, 0.3);
      lerpMorphTarget("viseme_O", mouthValue > 0.03 ? mouthValue * 0.3 : 0, 0.3);
      lerpMorphTarget("jawOpen", mouthValue > 0.03 ? mouthValue * 0.25 : 0, 0.2);
      lerpMorphTarget("mouthOpen", mouthValue > 0.03 ? mouthValue * 0.3 : 0, 0.2);

    } else {
      // ── NOT SPEAKING — close mouth ──
      for (const v of ALL_VISEMES) lerpMorphTarget(v, 0, 0.15);
      lerpMorphTarget("mouthOpen", 0, 0.15);
      lerpMorphTarget("jawOpen", 0, 0.15);
    }
  });


  return (
    <group ref={group} {...props} dispose={null}>
      <primitive object={scene} />
    </group>
  );
}

useGLTF.preload("/models/FemaleAvatar.glb");
useGLTF.preload("/models/animations_Female.glb");
