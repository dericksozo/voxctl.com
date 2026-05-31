import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development; only applied in `tauri dev`/`tauri build`.
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Lean, fast production output for a menu-bar app.
  build: {
    // Tauri uses a Safari/WebKit webview on macOS.
    target: "safari13",
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
      // Two entry points: the main dashboard window and the recording HUD overlay.
      input: {
        main: resolve(__dirname, "index.html"),
        hud: resolve(__dirname, "hud.html"),
      },
      output: {
        // Keep React in its own long-lived vendor chunk.
        manualChunks: {
          react: ["react", "react-dom", "react-dom/client"],
        },
      },
    },
  },
}));
