// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { captureLoginShellEnvironment } from "../src/terminal-environment.ts";

test("login shell environment parser preserves values containing equals signs", () => {
  let invocation: readonly unknown[] | undefined;
  const environment = captureLoginShellEnvironment("/bin/zsh", (...args) => {
    invocation = args;
    return "LANG=en_US.UTF-8\0TOKEN=left=right\0";
  });
  assert.deepEqual(environment, { LANG: "en_US.UTF-8", TOKEN: "left=right" });
  assert.deepEqual(invocation, ["/usr/bin/env", ["-i", "/bin/zsh", "-l", "-i", "-c", "env -0"], undefined, {}, 4_000]);
});

test("login shell environment parser rejects empty and malformed output", () => {
  assert.throws(() => captureLoginShellEnvironment("/bin/zsh", () => ""), /empty environment/u);
  assert.throws(() => captureLoginShellEnvironment("/bin/zsh", () => "BROKEN\0"), /invalid environment entry/u);
});
