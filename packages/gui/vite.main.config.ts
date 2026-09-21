import { defineConfig } from "vite";

// Bundles the Electron main process into a single ESM file shipped in the npm
// package (`ha gui` spawns dist-electron/electron-main.js; the .app path keeps
// running src/main/electron-main.ts unchanged). Workspace packages stay
// external: they are declared runtime dependencies of @harness-anything/gui and
// are resolved from the installed node_modules tree at launch.
export default defineConfig({
  build: {
    lib: {
      entry: "src/main/electron-main.ts",
      formats: ["es"],
      fileName: () => "electron-main.js",
    },
    outDir: "dist-electron",
    // The preload build owns cleaning this directory; run it before this one.
    emptyOutDir: false,
    target: "node20",
    minify: false,
    rollupOptions: {
      external: ["electron", /^node:/u, /^@harness-anything\//u],
    },
  },
});
