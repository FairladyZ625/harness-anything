import { builtinModules } from "node:module";
import { defineConfig } from "vite";

// Both npm and desktop distributions run this compiled main entry. Workspace
// runtime dependencies remain external and are staged through their npm pack
// lifecycle. The authorization-gui contracts are build-time values only, so
// they are bundled here and stay out of the published package dependencies.
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
      external: ["electron", ...builtinModules, /^node:/u, /^@harness-anything\/(?!authorization-gui(?:\/|$))/u],
    },
  },
});
