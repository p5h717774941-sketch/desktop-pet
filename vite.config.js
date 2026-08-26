import { defineConfig } from "vite";
import { resolve } from "node:path";

// Tauri expects a fixed dev server port and ignores file system changes in src-tauri.
export default defineConfig({
  root: "src",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    hmr: {
      protocol: "ws",
      host: "localhost",
      port: 1421,
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "src/index.html"),
        pet: resolve(import.meta.dirname, "src/pet.html"),
      },
    },
  },
});
