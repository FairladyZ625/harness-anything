import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: "src/main/electron-main.ts"
      }
    }
  },
  preload: {
    build: {
      lib: {
        entry: "src/preload/electron-preload.ts"
      }
    }
  },
  renderer: {
    root: ".",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: "index.html"
      }
    }
  }
});
