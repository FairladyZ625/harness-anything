import { defineConfig } from "vite";

// Both npm and desktop distributions run this compiled main entry. Workspace
// dependencies remain external and are staged through their npm pack lifecycle.
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
