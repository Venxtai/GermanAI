import { useRef, useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { CameraManager } from "./CameraManager";
import { Character } from "./Character";
import { Classroom } from "./Classroom";
import { ChalkboardText } from "./ChalkboardText";
import * as THREE from "three";

// Layer 1 = avatar-only lights (won't affect classroom background)
const AVATAR_LAYER = 1;

/**
 * A directional light that only affects objects on the avatar layer.
 * Uses ref to set layers after mount.
 */
function AvatarLight({ position, intensity, color, castShadow, ...props }) {
  const ref = useRef();
  useEffect(() => {
    if (ref.current) {
      ref.current.layers.set(AVATAR_LAYER);
    }
  }, []);
  return (
    <directionalLight
      ref={ref}
      position={position}
      intensity={intensity}
      color={color}
      castShadow={castShadow}
      {...props}
    />
  );
}

/**
 * Ensures camera can see layer 1 objects (avatar).
 */
function EnableCameraLayer() {
  const { camera } = useThree();
  useEffect(() => {
    camera.layers.enable(AVATAR_LAYER);
  }, [camera]);
  return null;
}

export function Experience() {
  return (
    <>
      <CameraManager />
      <EnableCameraLayer />

      {/* Scene-wide lighting — affects classroom + avatar equally */}
      {/* Keep these low since the classroom background has baked lighting */}
      <ambientLight intensity={0.5} />
      <hemisphereLight skyColor="#fff5e0" groundColor="#5a4020" intensity={0.6} />

      {/* Avatar-only lights — match the background's window lighting */}
      {/* These only affect objects on AVATAR_LAYER (layer 1) */}

      {/* KEY: Warm window light from the RIGHT side */}
      <AvatarLight
        position={[5, 4, 2]}
        intensity={2.2}
        color="#ffd890"
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-near={0.1}
        shadow-camera-far={20}
      />

      {/* Overhead — classroom ceiling lights */}
      <AvatarLight position={[0, 8, 0]} intensity={0.7} color="#fff5e8" />

      {/* Left fill — soft bounce from the wall */}
      <AvatarLight position={[-3, 3, -1]} intensity={0.25} color="#d4c4a0" />

      {/* 3D Classroom background */}
      <Classroom />

      {/* AI text rendered on the chalkboard surface */}
      <ChalkboardText />

      {/* Avaturn avatar — positioned in front of the board */}
      <Character
        position={[-0.45, -2.4, -2.8]}
        rotation={[THREE.MathUtils.degToRad(2), THREE.MathUtils.degToRad(55), 0]}
        scale={1.5}
        avatarLayer={AVATAR_LAYER}
      />
    </>
  );
}
