import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.vitest.ts", "test/**/*.vitest.tsx"]
  }
}));
