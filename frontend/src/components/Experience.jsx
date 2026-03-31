import { CameraManager } from "./CameraManager";
import { Character } from "./Character";
import { Classroom } from "./Classroom";
import { ChalkboardText } from "./ChalkboardText";
import * as THREE from "three";

export function Experience() {
  return (
    <>
      <CameraManager />

      {/* Lighting — warm classroom / indoor daylight */}
      <ambientLight intensity={0.5} />
      <hemisphereLight skyColor="#fff5e0" groundColor="#5a4020" intensity={0.6} />
      <directionalLight position={[3, 8, 5]} intensity={1.4} castShadow
        shadow-mapSize={[1024, 1024]} shadow-camera-near={0.1} shadow-camera-far={20} />
      <directionalLight position={[-2, 4, -3]} intensity={0.3} color="#ffd9a0" />

      {/* 3D Classroom background */}
      <Classroom />

      {/* AI text rendered on the chalkboard surface */}
      <ChalkboardText />

      {/* Naoki GLB — positioned in front of the board */}
      {/* Character moved forward + down for medium shot (waist up) */}
      <Character
        position={[-0.55, -2.2, -2.8]}
        rotation={[0, THREE.MathUtils.degToRad(15), 0]}
        scale={1.5}
      />
    </>
  );
}
