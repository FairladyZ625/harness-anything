import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: "index.html"
    }
  }
});
