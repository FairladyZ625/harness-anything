import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

// Off CI, cap worker fan-out so a local `check` run does not saturate a laptop.
// CI keeps vitest's own default — the hosted runners are sized for it and CI
// test semantics must not change.
const localMaxWorkers = process.env.CI ? undefined : 4;

export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.vitest.ts", "test/**/*.vitest.tsx"],
    ...(localMaxWorkers === undefined ? {} : { maxWorkers: localMaxWorkers })
  }
}));
