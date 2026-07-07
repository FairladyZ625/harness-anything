import { defineConfig } from "vite";

// Bundles the sandboxed preload (and its allowlist imports) into a single
// CommonJS file. Sandboxed Electron preloads cannot load ESM or resolve
// bare/multi-file imports, so this build step is required before launch.
export default defineConfig({
  build: {
    lib: {
      entry: "src/preload/electron-preload.ts",
      formats: ["cjs"],
      fileName: () => "electron-preload.cjs"
    },
    outDir: "dist-electron",
    emptyOutDir: true,
    target: "node20",
    minify: false,
    rollupOptions: {
      external: ["electron"]
    }
  }
});
