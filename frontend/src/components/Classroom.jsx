import { useGLTF } from "@react-three/drei";

// Switch between "default" and "alternative"
const CLASSROOM = "default"; // ← change to "alternative" to try the other one

const PLACEMENT = {
  default:     { position: [0.2, -1.7, -2] },
  alternative: { position: [0.3, -1.7, -1.5], rotation: [0, Math.PI / -2, 0], scale: 0.4 },
};

export function Classroom() {
  const { scene } = useGLTF(`/models/classroom_${CLASSROOM}.glb`);
  const p = PLACEMENT[CLASSROOM];
  return <primitive object={scene} position={p.position} rotation={p.rotation} scale={p.scale} />;
}

useGLTF.preload("/models/classroom_default.glb");
