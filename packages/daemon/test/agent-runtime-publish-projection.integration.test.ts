// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection, type RuntimeSession } from "../../kernel/src/index.ts";
import { makeAgentRuntimeStreamHub } from "../src/agent-runtime-stream.ts";
import { parseProviderFrame } from "../src/runtime-spawn-provider-frames.ts";
import { consumeProviderLine } from "../src/runtime-spawn-provider-stream.ts";

test("provider output publication does not scale full projection reads with line count", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-publish-projection-"));
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Runtime Projection Test");
  git(rootDir, "config", "user.email", "runtime-projection@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");

  const store = makeTaskEventStore({ repoId: "runtime-projection", rootDir });
  const projection = makeTaskProjection({ rootDir, eventStore: store });
  const session: RuntimeSession = {
    runtimeSessionId: "runtime-session",
    instanceId: "instance-runtime",
    installationId: "installation-runtime",
    kindId: "codex",
    definitionSnapshotRef: "artifact:runtime-definition/test",
    providerSessionId: null,
    transcriptRef: null,
    launchGeneration: 1,
    liveness: "live",
    attachable: true,
    taskBindings: [],
    outcome: null,
    exitCode: null,
    resultRef: null,
    lastObservedAt: "2026-08-13T00:00:00.000Z",
  };
  let fullProjectionReads = 0;
  const stream = makeAgentRuntimeStreamHub({
    readSession: (runtimeSessionId) => {
      fullProjectionReads += 1;
      projection.list();
      return runtimeSessionId === session.runtimeSessionId ? session : null;
    },
    canAttach: ({ attachable }) => attachable,
    now: () => new Date("2026-08-13T00:00:00.000Z"),
  });
  const active = {
    runtimeSessionId: session.runtimeSessionId,
    kindId: "codex",
    stream: { appendProviderEvent: () => undefined },
    durableOutputCount: 0,
    finalText: null,
    failureText: null,
    providerOutcome: null,
    writeItemObserved: false,
    planObserved: false,
    planIncomplete: false,
    protocolError: false,
  } as never;
  const context = {
    input: { stream, now: () => "2026-08-13T00:00:00.000Z" },
    parseProviderFrame,
    bindProvider: async () => undefined,
    markProtocolError: () => assert.fail("valid provider output was rejected"),
    isStructuredSuccessResult: () => false,
  };

  try {
    for (let index = 0; index < 1_000; index += 1)
      await consumeProviderLine(
        context,
        active,
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: `line-${index}` },
        }),
      );

    assert.equal(fullProjectionReads, 0);
    const attached = stream.attach(session.runtimeSessionId, "stream:1000");
    assert.equal(attached.initial.ok, true);
    attached.detach();
    stream.issueWitnessToken(session.runtimeSessionId, {
      principalId: "person-owner",
      source: "local",
    });
    assert.equal(fullProjectionReads, 2);
  } finally {
    stream.close();
    projection.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
