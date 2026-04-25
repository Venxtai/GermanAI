import { useEffect, useRef } from "react";
import { CameraControls } from "@react-three/drei";
import useAIStore from "../store/useAIStore";

// Final close-up position (all states use the same framing)
const FINAL_POS = { position: [0.1, 0, -1.5], target: [0, 0, -10] };

// Starting position for the fly-in: back-right of the classroom, slightly higher
const INTRO_POS = { position: [1.5, 1.2, 2], target: [0.5, 0.3, -5] };

export function CameraManager() {
  const controlsRef = useRef();
  const isFirstMount = useRef(true);
  const status = useAIStore((s) => s.status);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    if (isFirstMount.current) {
      isFirstMount.current = false;

      // Snap to the intro (far) position instantly
      controls.setLookAt(
        INTRO_POS.position[0], INTRO_POS.position[1], INTRO_POS.position[2],
        INTRO_POS.target[0], INTRO_POS.target[1], INTRO_POS.target[2],
        false
      );

      // Then smoothly fly in to the close-up after a short delay
      setTimeout(() => {
        controls.smoothTime = 1.2; // seconds for the fly-in
        controls.setLookAt(
          FINAL_POS.position[0], FINAL_POS.position[1], FINAL_POS.position[2],
          FINAL_POS.target[0], FINAL_POS.target[1], FINAL_POS.target[2],
          true
        );
      }, 300);

      return;
    }

    // Subsequent status changes — animate between positions
    controls.smoothTime = 0.5;
    controls.setLookAt(
      FINAL_POS.position[0], FINAL_POS.position[1], FINAL_POS.position[2],
      FINAL_POS.target[0], FINAL_POS.target[1], FINAL_POS.target[2],
      true
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
