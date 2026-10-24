// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { launchArgs } from "../src/agent-runtime-launch-config.ts";
import { runtimeKindForId } from "../src/runtime-inventory.ts";
import type { RuntimeInstanceConfig } from "../src/agent-runtime-instance-types.ts";

// The task prompt is the one launch input composed freely, and on Windows a .cmd-shim
// runtime re-parses the whole argv through cmd.exe, where no quoting can carry %VAR%, CR
// or LF verbatim (BatBadBut, CVE-2024-24576). A CLI whose print mode reads the prompt from
// a piped stdin must therefore keep the prompt out of argv entirely; the argv-prompt kind
// (zcode: no stdin or file prompt channel exists in its CLI) rides on the shared cmd
// encoder in kernel/src/store/cmd-command-line.ts instead.
const hostilePrompt = 'say " & calc & " and %PATH% and ^';

function instanceConfig(kindId: "agy" | "zcode"): RuntimeInstanceConfig {
  return {
    schemaVersion: 2,
    instanceId: `${kindId}-prompt-channel`,
    name: "Prompt Channel",
    kindId,
    installationId: `${kindId}-installation`,
    providerId: "provider",
    models: ["model-a"],
    defaultModel: "model-a",
    enabled: true,
    isolationState: "operator-environment",
    auth: { mode: "subscription" },
  };
}

test("agy keeps the task prompt off the command line", () => {
  const args = launchArgs(instanceConfig("agy"), "model-a", hostilePrompt, undefined, null, "bypass", false);
  // stdin print mode (measured 2026-10-24: piped stdin without -p logs the stdin prompt
  // length) is the whole delivery; nothing prompt-derived may join a command line.
  assert.deepEqual(args, [
    "--output-format",
    "stream-json",
    "--print-timeout",
    "30m",
    "--model",
    "model-a",
    "--dangerously-skip-permissions",
  ]);
  for (const argument of args)
    assert.ok(!argument.includes(hostilePrompt) && !argument.includes("calc") && !argument.includes("%PATH%"));
  assert.equal(runtimeKindForId("agy").launch.input, "stdin");
});

test("zcode still carries --prompt in argv because its CLI has no other prompt channel", () => {
  // Shape pin, green before and after the fix: zcode.cjs (0.16.9) starts a headless run
  // only from the --prompt value (util.parseArgs string option, no stdin or file fallback),
  // so this kind is exactly what the shared cmd encoder has to make safe.
  const args = launchArgs(instanceConfig("zcode"), "model-a", hostilePrompt, undefined, undefined, "bypass", false);
  assert.deepEqual(args, ["--output-format", "stream-json", "--mode", "yolo", "--prompt", hostilePrompt]);
});
