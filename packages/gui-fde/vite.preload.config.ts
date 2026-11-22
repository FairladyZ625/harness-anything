import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/preload/electron-preload.ts",
      formats: ["cjs"],
      fileName: () => "electron-preload.cjs",
    },
    outDir: "dist-electron",
    emptyOutDir: true,
    target: "node20",
    minify: false,
    rollupOptions: {
      external: ["electron"],
    },
  },
});
