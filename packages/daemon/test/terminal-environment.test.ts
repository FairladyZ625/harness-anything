// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { captureLoginShellEnvironment, terminalEnvironment } from "../src/terminal-environment.ts";

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

test("terminal environment caches a clean snapshot and overlays enumerated session channels", () => {
  const previous = process.env.SSH_AUTH_SOCK,
    previousSecret = process.env.RUNTIME_ONLY_SECRET,
    previousLang = process.env.LANG;
  process.env.SSH_AUTH_SOCK = "/private/tmp/agent.sock";
  process.env.RUNTIME_ONLY_SECRET = "must-not-cross";
  // LANG is a session channel now, so an ambient value would overlay the captured one and make
  // this assertion depend on whoever started the test runner.
  delete process.env.LANG;
  let captures = 0;
  try {
    const capture = () => {
      captures += 1;
      return { LANG: "en_US.UTF-8", PROFILE_EXPORT: "included" };
    };
    const first = terminalEnvironment("darwin", "/test/cache-shell", capture);
    const second = terminalEnvironment("darwin", "/test/cache-shell", capture);
    assert.equal(first, second);
    assert.equal(captures, 1);
    assert.equal(first.LANG, "en_US.UTF-8");
    assert.equal(first.PROFILE_EXPORT, "included");
    assert.equal(first.SSH_AUTH_SOCK, "/private/tmp/agent.sock");
    assert.equal(first.TERM, "xterm-256color");
    assert.equal("RUNTIME_ONLY_SECRET" in first, false);
  } finally {
    if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previous;
    if (previousSecret === undefined) delete process.env.RUNTIME_ONLY_SECRET;
    else process.env.RUNTIME_ONLY_SECRET = previousSecret;
    if (previousLang === undefined) delete process.env.LANG;
    else process.env.LANG = previousLang;
  }
});

test("terminal environment warns and falls back to the legacy keys when capture fails", () => {
  const warnings: unknown[][] = [],
    previousWarn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values);
  try {
    const environment = terminalEnvironment("linux", "/test/failing-shell", () => {
      throw new Error("timed out");
    });
    assert.equal(environment.TERM, "xterm-256color");
    assert.equal(environment.PATH, process.env.PATH);
    assert.equal("SSH_AUTH_SOCK" in environment, false);
    assert.match(String(warnings[0]?.[0]), /snapshot failed.*timed out/u);
  } finally {
    console.warn = previousWarn;
  }
});

test("a failed snapshot is not cached so the next terminal retries", () => {
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    let attempts = 0;
    const capture = () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
      return { LANG: "en_US.UTF-8", PROFILE_EXPORT: "included" };
    };
    const first = terminalEnvironment("linux", "/test/retry-shell", capture);
    assert.equal("PROFILE_EXPORT" in first, false);
    const second = terminalEnvironment("linux", "/test/retry-shell", capture);
    assert.equal(second.PROFILE_EXPORT, "included");
    assert.equal(attempts, 2);
  } finally {
    console.warn = previousWarn;
  }
});

test("terminal environment prefers the session locale over the one login profiles produce", () => {
  const previous = process.env.LANG;
  process.env.LANG = "en_US.UTF-8";
  try {
    const environment = terminalEnvironment("darwin", "/test/locale-shell", () => ({
      LANG: "C.UTF-8",
      PATH: "/usr/bin",
    }));
    assert.equal(environment.LANG, "en_US.UTF-8");
  } finally {
    if (previous === undefined) delete process.env.LANG;
    else process.env.LANG = previous;
  }
});
