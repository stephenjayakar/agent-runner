import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "frontend",
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3111",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../dist/frontend",
  },
});
