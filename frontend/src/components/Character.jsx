import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { useAnimations, useGLTF } from "@react-three/drei";
import { MathUtils, LoopRepeat, LoopOnce } from "three";
import { randInt } from "three/src/math/MathUtils";
import useAIStore from "../store/useAIStore";

const ANIMATION_FADE_TIME = 0.5;

// Lip visemes — subtle mouth shaping driven by audio energy
const LIP_VISEMES = [
  "viseme_aa",
  "viseme_O",
  "viseme_E",
  "viseme_DD",
];

// Very subtle secondary — barely visible, for natural variation
const SECONDARY_VISEMES = [
  "viseme_FF",
  "viseme_SS",
  "viseme_nn",
];

export function Character(props) {
  const group = useRef();

  // Load female avatar model + Mixamo animations (made for her skeleton)
  const { scene } = useGLTF("/models/FemaleAvatar.glb");
  const { animations } = useGLTF("/models/animations_Female.glb");
  const { actions, mixer } = useAnimations(animations, group);

  const [animation, setAnimation] = useState("Idle");
  const [blink, setBlink] = useState(false);

  const status       = useAIStore((s) => s.status);
  const analyzerNode = useAIStore((s) => s.analyzerNode);
  const amplitudeDataRef = useRef(new Uint8Array(128));
  const isTalkingRef = useRef(false);
  const idleTimerRef = useRef(null);
  const isFirstSpeakRef = useRef(true); // Track first speaking turn for greeting

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

  // Per-frame: lipsync + blink + smile
  useFrame(() => {
    // Blink
    lerpMorphTarget("eyeBlinkLeft", blink ? 1 : 0, 0.5);
    lerpMorphTarget("eyeBlinkRight", blink ? 1 : 0, 0.5);

    // Subtle idle smile
    lerpMorphTarget("mouthSmileLeft", 0.15, 0.3);
    lerpMorphTarget("mouthSmileRight", 0.15, 0.3);

    // Audio-driven lipsync
    let audioEnergy = 0;
    if (analyzerNode) {
      analyzerNode.getByteFrequencyData(amplitudeDataRef.current);
      audioEnergy = amplitudeDataRef.current.slice(1, 15).reduce((a, b) => a + b, 0) / 14;
    }

    const mouthValue = status === "speaking"
      ? MathUtils.clamp(audioEnergy / 120, 0, 0.2)
      : 0;

    for (const v of LIP_VISEMES) {
      lerpMorphTarget(v, mouthValue > 0.03 ? mouthValue : 0, 0.3);
    }
    for (const v of SECONDARY_VISEMES) {
      lerpMorphTarget(v, mouthValue > 0.03 ? mouthValue * 0.3 : 0, 0.2);
    }
    lerpMorphTarget("jawOpen", mouthValue > 0.03 ? mouthValue * 0.3 : 0, 0.2);
    lerpMorphTarget("mouthOpen", mouthValue > 0.03 ? mouthValue * 0.4 : 0, 0.2);

    if (status !== "speaking") {
      lerpMorphTarget("mouthOpen", 0, 0.15);
      lerpMorphTarget("jawOpen", 0, 0.15);
      for (const v of LIP_VISEMES) lerpMorphTarget(v, 0, 0.15);
      for (const v of SECONDARY_VISEMES) lerpMorphTarget(v, 0, 0.15);
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
