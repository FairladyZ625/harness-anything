// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentRollbackCommand, runAgentRollback } from "../src/cli-agent-rollback.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import type { ThinCommand } from "../src/cli/thin-command.ts";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";

/**
 * `ha agent rollback` is a composition: read the target version, read the live revision, refuse a
 * byte-identical no-op, then submit the retained body as `agent-install`. These tests pin the call
 * sequence (the no-op must not submit at all) and the fence value the install receives.
 */

const base = { rootDir: "/repo", repoId: "repo-a" } as unknown as Pick<ThinCommand, "rootDir" | "repoId">,
  sha = (fill: string) => fill.repeat(64);

interface Recorded {
  readonly method: string;
  readonly action: Record<string, unknown>;
}

/** Answers like the daemon would: a version read, then the install receipt. */
function stub(responses: readonly JsonObject[]): {
  readonly calls: Recorded[];
  readonly request: (command: ThinCommand) => Promise<JsonObject>;
} {
  const calls: Recorded[] = [],
    queue = [...responses];
  return {
    calls,
    request: async (command) => {
      calls.push({ method: command.method, action: { ...command.action } });
      const next = queue.shift();
      assert.ok(next, `unexpected request ${command.method} ${String(command.action.kind)}`);
      return next;
    },
  };
}

const versionReceipt = (input: {
  readonly revision: number;
  readonly liveRevision: number;
  readonly liveSha?: string;
  readonly instructions?: string;
}): JsonObject => ({
  ok: true,
  opId: "op-version-read",
  revision: input.liveRevision,
  evidence: JSON.stringify({
    schema: "agent-version/v1",
    ok: true,
    agentId: "terra",
    version: {
      revision: input.revision,
      opId: `op-${input.revision}`,
      sha256: sha("a"),
      size: 120,
      occurredAt: "2026-10-26T00:00:00.000Z",
      actor: { personId: "person-a", executorId: null },
      current: input.revision === input.liveRevision,
      summary: "instructions 120 B · 0 skills · 1 runtime",
    },
    current: { revision: input.liveRevision, sha256: input.liveSha ?? sha("b") },
    declaration: {
      schema: "agent-declaration/v1",
      id: "terra",
      name: "Terra",
      instructions: input.instructions ?? "old instructions",
      runtimes: [{ type: "codex" }],
    },
    fields: [],
    truncated: false,
  }),
});

test("rollback reads the target version and submits the retained body with the live fence", async () => {
  const stubber = stub([
      versionReceipt({ revision: 1, liveRevision: 3, instructions: "v1 instructions" }),
      { ok: true, outcome: "applied", revision: 4, opId: "op-install" },
    ]),
    result = await runAgentRollback(
      { agentId: "terra", toRevision: 1, expectedVersion: undefined, json: false },
      stubber.request,
      base,
    );
  assert.equal(stubber.calls.length, 2, "one read plus one write");
  assert.deepEqual(stubber.calls[0], {
    method: "repo.task.read",
    action: { kind: "agent-version-read", agentId: "terra", revision: 1 },
  });
  assert.deepEqual(stubber.calls[1], {
    method: "repo.task.run",
    action: {
      kind: "agent-install",
      declaration: {
        schema: "agent-declaration/v1",
        id: "terra",
        name: "Terra",
        instructions: "v1 instructions",
        runtimes: [{ type: "codex" }],
      },
      expectedVersion: 3,
      idempotencyKey: "agent-rollback:terra:1:3",
    },
  });
  assert.equal(result.command, "agent-rollback");
  assert.equal(result.ok, true);
  assert.equal(result.targetRevision, 1);
  assert.equal(result.targetSha256, sha("a"));
});

test("a caller-supplied expectedVersion wins over the one this read observed", async () => {
  const stubber = stub([
      versionReceipt({ revision: 1, liveRevision: 3 }),
      { ok: false, outcome: "op_rejected", code: "revision_conflict" },
    ]),
    result = await runAgentRollback(
      { agentId: "terra", toRevision: 1, expectedVersion: 2, json: false },
      stubber.request,
      base,
    );
  assert.equal(stubber.calls[1]?.action.expectedVersion, 2);
  assert.equal(result.code, "revision_conflict");
});

test("rolling back to the version that is already live submits nothing", async () => {
  const stubber = stub([
      // Same revision and the same body digest as the live declaration: nothing to restore.
      versionReceipt({ revision: 3, liveRevision: 3, liveSha: sha("a") }),
    ]),
    result = await runAgentRollback(
      { agentId: "terra", toRevision: 3, expectedVersion: undefined, json: false },
      stubber.request,
      base,
    );
  assert.equal(stubber.calls.length, 1, "a no-op must not call the install action");
  assert.equal(result.outcome, "no_changes");
  assert.equal(result.changed, false);
  assert.equal(result.revision, 3);
  assert.match(String(result.nextAction), /already holds the body of revision 3/u);
});

test("a version read failure is returned as-is and never becomes a write", async () => {
  const stubber = stub([{ ok: false, code: "agent_version_not_found", error: { code: "agent_version_not_found" } }]),
    result = await runAgentRollback(
      { agentId: "terra", toRevision: 9, expectedVersion: undefined, json: false },
      stubber.request,
      base,
    );
  assert.equal(stubber.calls.length, 1);
  assert.equal(result.code, "agent_version_not_found");
});

test("an install rejection keeps its code so the caller can act on it", async () => {
  const stubber = stub([
      versionReceipt({ revision: 1, liveRevision: 3 }),
      { ok: false, code: "agent_retired", outcome: "op_rejected" },
    ]),
    result = await runAgentRollback(
      { agentId: "terra", toRevision: 1, expectedVersion: 3, json: false },
      stubber.request,
      base,
    );
  assert.equal(result.code, "agent_retired");
  assert.equal(result.command, undefined, "a failed install is not re-labelled as a rollback receipt");
});

test("the CLI parses the rollback flags and rejects malformed revisions before any request", () => {
  const parsed = parseThinCommand([
    "agent",
    "rollback",
    "terra",
    "--to-revision",
    "2",
    "--expected-version",
    "3",
    "--json",
  ]);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.nextAction);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.command.action, {
    kind: "agent-rollback",
    agentId: "terra",
    toRevision: 2,
    expectedVersion: 3,
  });
  assert.equal(parsed.command.method, "repo.task.read");
  assert.equal(parsed.command.id, "agent-rollback");

  for (const argv of [
    ["agent", "rollback", "terra"],
    ["agent", "rollback", "terra", "--to-revision", "0"],
    ["agent", "rollback", "terra", "--to-revision", "two"],
    ["agent", "rollback", "terra", "--to-revision", "2", "--expected-version", "-1"],
  ]) {
    const rejected = parseThinCommand(argv);
    assert.equal(rejected.ok, false, `${argv.join(" ")} must be rejected`);
  }
  const command = parseAgentRollbackCommand({
    ...base,
    method: "repo.task.read",
    json: false,
    action: { kind: "agent-rollback", agentId: "terra", toRevision: 2, expectedVersion: 3 },
  } as ThinCommand);
  assert.deepEqual(command, { agentId: "terra", toRevision: 2, expectedVersion: 3, json: false });
});
