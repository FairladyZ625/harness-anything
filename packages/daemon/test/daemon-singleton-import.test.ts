// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("daemon PID observation does not load the kernel runtime", () => {
  const entry = new URL("../src/daemon-singleton.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { registerHooks } from "node:module";
const resolved = new Set();
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  resolved.add(result.url);
  return result;
} });
const { readDaemonPid } = await import(${JSON.stringify(entry)});
if (typeof readDaemonPid !== "function") throw new Error("missing PID observer");
console.log(JSON.stringify([...resolved]));`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const modules: string[] = JSON.parse(result.stdout);
  const kernelModules = modules.filter((url) => /\/packages\/kernel\/|\/node_modules\/effect\//u.test(url));
  assert.equal(
    kernelModules.length,
    0,
    `the per-command PID observer loaded ${kernelModules.length} kernel runtime modules; first: ${kernelModules[0]}`,
  );
});
