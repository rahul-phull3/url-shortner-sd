import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: { outDir: "../dist/client", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/r": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
});
