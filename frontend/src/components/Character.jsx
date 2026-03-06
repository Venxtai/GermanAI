import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { useAnimations, useGLTF } from "@react-three/drei";
import { MathUtils, LoopRepeat } from "three";
import { randInt } from "three/src/math/MathUtils";
import useAIStore from "../store/useAIStore";

const ANIMATION_FADE_TIME = 0.5;

// Open-mouth viseme indices to drive when audio energy is detected
const OPEN_MOUTH_VISEMES = [1, 2, 5, 10, 14];

export function Character(props) {
  const group = useRef();

  // Load Naoki model (with morph targets) + separate animations GLB
  const { scene } = useGLTF("/models/Teacher.glb");
  const { animations } = useGLTF("/models/animations_Teacher.glb");
  const { actions, mixer } = useAnimations(animations, group);

  const [animation, setAnimation] = useState("Idle");
  const [blink, setBlink] = useState(false);

  const status       = useAIStore((s) => s.status);
  const analyzerNode = useAIStore((s) => s.analyzerNode);
  const amplitudeDataRef = useRef(new Uint8Array(128)); // frequencyBinCount for fftSize 256
  const isTalkingRef = useRef(false);
  const idleTimerRef = useRef(null);

  // Blink loop
  useEffect(() => {
    let blinkTimeout;
    const nextBlink = () => {
      blinkTimeout = setTimeout(() => {
        setBlink(true);
        setTimeout(() => {
          setBlink(false);
          nextBlink();
        }, 100);
      }, randInt(1000, 5000));
    };
    nextBlink();
    return () => clearTimeout(blinkTimeout);
  }, []);

  // Animation state based on AI status
  useEffect(() => {
    if (status === "loading") {
      clearTimeout(idleTimerRef.current);
      isTalkingRef.current = false;
      setAnimation("Thinking");
    } else if (status === "speaking") {
      clearTimeout(idleTimerRef.current);
      if (!isTalkingRef.current) {
        isTalkingRef.current = true;
        setAnimation(randInt(0, 1) ? "Talking" : "Talking2");
      }
    } else {
      // Status is idle — switch to Idle animation immediately
      // (silence detection in useVoiceConnection already waited 1.5s after audio ended)
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
    actions[animation]
      .reset()
      .setLoop(LoopRepeat, Infinity)
      .fadeIn(mixer.time > 0 ? ANIMATION_FADE_TIME : 0)
      .play();
    return () => {
      actions[animation]?.fadeOut(ANIMATION_FADE_TIME);
    };
  }, [animation, actions, mixer]);

  // Lerp a morph target by name
  const lerpMorphTarget = (target, value, speed = 0.1) => {
    scene.traverse((child) => {
      if (child.isSkinnedMesh && child.morphTargetDictionary) {
        const index = child.morphTargetDictionary[target];
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
    lerpMorphTarget("mouthSmile", 0.2, 0.5);
    lerpMorphTarget("eye_close", blink ? 1 : 0, 0.5);

    // Audio energy from analyzerNode
    let audioEnergy = 0;
    if (analyzerNode) {
      analyzerNode.getByteFrequencyData(amplitudeDataRef.current);
      // fftSize=256 → 128 bins, each ~187Hz wide at 48kHz
      // Bins 1-15 covers ~187Hz–2800Hz (voice fundamentals + formants)
      audioEnergy = amplitudeDataRef.current.slice(1, 15).reduce((a, b) => a + b, 0) / 14;
    }

    const mouthValue = status === "speaking"
      ? MathUtils.clamp(audioEnergy / 80, 0, 0.4)
      : 0;

    // Reset all viseme targets, then drive open-mouth ones by energy
    for (let i = 0; i <= 21; i++) {
      lerpMorphTarget(i, 0, 0.1);
    }
    if (mouthValue > 0.05) {
      OPEN_MOUTH_VISEMES.forEach((v) => lerpMorphTarget(v, mouthValue, 0.2));
    }
  });

  return (
    <group ref={group} {...props} dispose={null}>
      <primitive object={scene} />
    </group>
  );
}

useGLTF.preload("/models/Teacher.glb");
useGLTF.preload("/models/animations_Teacher.glb");
