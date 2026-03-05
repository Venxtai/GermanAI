import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/token": "http://localhost:3000",
      "/api": "http://localhost:3000",
      "/log-stream": {
        target: "http://localhost:3000",
        changeOrigin: true,
        // SSE requires no buffering
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["cache-control"] = "no-cache";
          });
        },
      },
      "/log-viewer": "http://localhost:3000",
    },
  },
});
