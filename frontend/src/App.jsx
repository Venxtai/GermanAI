import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { Experience } from "./components/Experience";
import { UI } from "./components/UI";

function App() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        background: "#000",
      }}
    >
      {/* Overlay UI — always on top of canvas */}
      <div style={{ position: "relative", zIndex: 10 }}>
        <UI />
      </div>

      {/* 3D Canvas — transparent, sits behind UI */}
      <Canvas
        shadows
        camera={{ position: [0, 0.5, 1.5], fov: 55, near: 0.1, far: 100 }}
        style={{ width: "100%", height: "100%", position: "absolute", top: 0, left: 0, zIndex: 0 }}
        gl={{ antialias: true, alpha: false }}
      >
        <Suspense fallback={null}>
          <Experience />
        </Suspense>
      </Canvas>
    </div>
  );
}

export default App;
