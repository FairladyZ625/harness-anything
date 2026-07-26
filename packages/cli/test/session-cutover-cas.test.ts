// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { writeContentAddressedBlob, type WriteError } from "@harness-anything/kernel";
import { runSessionSync } from "../src/commands/core/session-cutover.ts";
import type { CommandRunnerContext } from "../src/cli/runner-registry.ts";

test("session sync removes newly created CAS bodies when manifest submission fails", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-session-cutover-cas-"));
  try {
    const sessionsRoot = path.join(rootDir, "harness", "sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(path.join(sessionsRoot, "legacy.md"), legacySession(), "utf8");
    const context = { layoutInput: { rootDir } } as CommandRunnerContext;
    const rejection = { _tag: "WriteRejected", reason: "forced cutover rejection" } satisfies WriteError;

    const exit = await runEffect(Effect.either(runSessionSync(
      context,
      { kind: "session-sync", mode: "apply" },
      () => Effect.fail(rejection)
    )));

    assert.equal(exit._tag, "Left");
    assert.deepEqual(listObjectFiles(rootDir), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("session sync never removes a pre-existing CAS body when manifest submission fails", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-session-cutover-existing-cas-"));
  try {
    const sessionsRoot = path.join(rootDir, "harness", "sessions");
    const body = legacySession();
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(path.join(sessionsRoot, "legacy.md"), body, "utf8");
    const existing = writeContentAddressedBlob(rootDir, body, "text/markdown; charset=utf-8");
    const context = { layoutInput: { rootDir } } as CommandRunnerContext;
    const rejection = { _tag: "WriteRejected", reason: "forced cutover rejection" } satisfies WriteError;

    await runEffect(Effect.either(runSessionSync(
      context,
      { kind: "session-sync", mode: "apply" },
      () => Effect.fail(rejection)
    )));

    assert.equal(existsSync(path.join(rootDir, existing.ref)), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function legacySession(): string {
  return [
    "---",
    "schema: provenance-session/v1",
    "sessionId: legacy",
    "runtime: codex",
    "source: runtime",
    "detectedAt: 2026-07-04T00:00:00.000Z",
    "exportedAt: 2026-07-04T00:01:00.000Z",
    "---",
    "",
    "# Session legacy",
    ""
  ].join("\n");
}

function listObjectFiles(rootDir: string): ReadonlyArray<string> {
  const objectRoot = path.join(rootDir, "harness", "objects");
  if (!existsSync(objectRoot)) return [];
  const files: string[] = [];
  const pending = [objectRoot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  return files;
}

function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return new Promise((resolve, reject) => {
    Effect.runCallback(effect, {
      onExit: (exit) => exit._tag === "Success" ? resolve(exit.value) : reject(new Error(String(exit.cause)))
    });
  });
}
