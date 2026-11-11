// harness-test-tier: contract
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "vite";
import config from "../vite.config.ts";

const source = (relative) => fileURLToPath(new URL(relative, import.meta.url));

test("receipt consumers build with the production renderer Node builtin guard", async () => {
  const inputs = {
    runtime: source("../src/renderer/runtime-control.ts"),
    api: source("../src/renderer/api-client.ts"),
    connections: source("../src/renderer/connection-admin-client.ts"),
  };
  const result = await build({
    configFile: false,
    plugins: [config.plugins[0]],
    resolve: { alias: { "@harness-anything/kernel/browser": source("../../kernel/src/browser.ts") } },
    build: { write: false, rollupOptions: { input: inputs } },
  });
  assert.deepEqual(
    result.output
      .filter((entry) => entry.type === "chunk" && entry.isEntry)
      .map((entry) => entry.facadeModuleId)
      .sort(),
    Object.values(inputs).sort(),
  );
});
