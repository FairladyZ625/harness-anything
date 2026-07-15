#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function selectStopPoint(env = process.env) {
  const ci = /^(?:1|true)$/iu.test(env.CI ?? "");
  return ci
    ? { mode: "CI", script: "tools/run-ci-equivalent.mjs" }
    : { mode: "local", script: "tools/run-local-check.mjs" };
}

export function main(env = process.env) {
  const selected = selectStopPoint(env);
  console.log(`Canonical stop point selected ${selected.mode} gates (${selected.script}).`);
  const result = spawnSync(process.execPath, [selected.script], {
    env,
    stdio: "inherit"
  });
  if (result.error) {
    console.error(`Stop point failed to launch: ${result.error.message}`);
    return 1;
  }
  if (result.signal !== null) {
    console.error(`Stop point terminated by signal ${result.signal}. Rerun npm run check:stop-point.`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
