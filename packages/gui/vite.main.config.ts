import { builtinModules } from "node:module";
import { defineConfig } from "vite";

// Both npm and desktop distributions run this compiled main entry. Workspace
// runtime dependencies remain external and are staged through their npm pack
// lifecycle. Bundle the desktop authorization contracts with the main entry,
// as with the preload and renderer builds.
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
      // Bundled CommonJS dependencies (electron-updater -> fs-extra) require bare
      // builtins such as "fs"; without these they resolve to an empty browser stub.
      platform: "node",
      external: ["electron", ...builtinModules, /^node:/u, /^@harness-anything\/(?!authorization\/gui(?:\/|$))/u],
    },
  },
});
