import { useEffect, useRef } from "react";
import { CameraControls } from "@react-three/drei";
import useAIStore from "../store/useAIStore";

// Camera at front row, centered, facing straight at board (original position)
const CAMERA_POSITIONS = {
  idle:      { position: [0.1, 0, -1.5], target: [0, 0, -10] },
  listening: { position: [0.1, 0, -1.5], target: [0, 0, -10] },
  speaking:  { position: [0.1, 0, -1.5], target: [0, 0, -10] },
  loading:   { position: [0.1, 0, -1.5], target: [0, 0, -10] },
};

export function CameraManager() {
  const controlsRef = useRef();
  const status = useAIStore((s) => s.status);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    const pos = CAMERA_POSITIONS[status] || CAMERA_POSITIONS.idle;

    controls.setLookAt(
      pos.position[0],
      pos.position[1],
      pos.position[2],
      pos.target[0],
      pos.target[1],
      pos.target[2],
      true // animate
    );
  }, [status]);

  return (
    <CameraControls
      ref={controlsRef}
      enabled={false}
      minDistance={2}
      maxDistance={10}
    />
  );
}
