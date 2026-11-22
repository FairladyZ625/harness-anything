import { builtinModules } from "node:module";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: {
        "electron-main": "src/main/electron-main.ts",
        "fde-server": "src/server/fde-server.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    outDir: "dist-electron",
    emptyOutDir: false,
    target: "node20",
    minify: false,
    rollupOptions: {
      platform: "node",
      external: ["electron", ...builtinModules, /^node:/u, /^@harness-anything\//u],
    },
  },
});
