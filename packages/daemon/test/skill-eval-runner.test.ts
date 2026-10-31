// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  openDaemonHost,
  SkillEvalRunner,
  type SkillEvalCase,
  type SkillEvalRuntimePort,
  type SkillEvalSkill,
  type SkillEvalStore,
} from "../src/index.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";

function fixture() {
  const skill: SkillEvalSkill = {
    skillId: "report",
    version: "1.0.0",
    digest: "a".repeat(64),
    status: "draft",
    createdBy: "drafter",
    usageMarker: "<!-- skill:report -->",
    requiredText: ["Verified"],
    body: "Always return a verified report.",
  };
  const cases: SkillEvalCase[] = [
    {
      id: "public",
      input: "summarise",
      hidden: false,
      expect: { contains: ["Verified"] },
      createdBy: "operator",
      createdAt: "2026-10-31T00:00:00.000Z",
    },
    {
      id: "hidden",
      input: "secret input",
      hidden: true,
      expect: { forbidden: ["secret"] },
      createdBy: "operator",
      createdAt: "2026-10-31T00:00:01.000Z",
    },
  ];
  const evaluations: unknown[] = [];
  const store: SkillEvalStore = {
    getSkill: (_skillId, version) => (version === "latest" || version === skill.version ? skill : null),
    listCases: () => cases,
    appendCase: (_skillId, item) => {
      if (cases.some((candidate) => candidate.id === item.id))
        throw Object.assign(new Error("duplicate"), { code: "CONFLICT" });
      cases.push(item);
    },
    recordEvaluation: (value) => evaluations.push(value),
  };
  const calls: { readonly cwd: string; readonly prompt: string }[] = [];
  const runtime: SkillEvalRuntimePort = {
    dispatch: async (request) => {
      calls.push({ cwd: request.cwd, prompt: request.prompt });
      return { status: "completed", output: "<!-- skill:report --> Verified" };
    },
  };
  const releases: string[] = [];
  const queue = {
    acquire: async () => undefined,
    release: (attemptId: string) => releases.push(attemptId),
  };
  return { skill, cases, evaluations, store, runtime, calls, releases, queue };
}

test("redacts hidden case input and expectations for the drafting principal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-eval-"));
  try {
    const f = fixture();
    const runner = new SkillEvalRunner(f.store, f.runtime, { runRoot: root, binding: { runtime: "local" } });
    const rows = await runner.listCases({ principalId: "drafter", role: "drafter" }, "report");
    assert.deepEqual(rows[1], {
      id: "hidden",
      input: null,
      hidden: true,
      expect: null,
      createdBy: "operator",
      createdAt: "2026-10-31T00:00:01.000Z",
    });
    const curatorRows = await runner.listCases(
      { principalId: "reviewer", role: "reviewer", canReview: true },
      "report",
    );
    assert.equal(curatorRows[1]?.input, "secret input");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exposes the runner through the daemon package composition surface", () => {
  assert.equal(typeof SkillEvalRunner, "function");
});

test("keeps the runner injectable through the resident daemon start composition", async () => {
  const userRoot = await mkdtemp(path.join(tmpdir(), "skill-eval-daemon-"));
  try {
    const f = fixture();
    const runner = new SkillEvalRunner(f.store, f.runtime, { runRoot: userRoot, binding: { runtime: "local" } });
    const host = await openDaemonHost({ daemonId: "skill-eval", userRoot, skillEvalRunner: runner });
    try {
      assert.equal(host.skillEvalRunner, runner);
    } finally {
      await host.close();
    }
  } finally {
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("routes the resident daemon skill-evaluation protocol through composed policy, storage, runtime, and slots", async () => {
  const userRoot = await mkdtemp(path.join(tmpdir(), "skill-eval-production-"));
  try {
    const f = fixture();
    const host = await openDaemonHost({
      daemonId: "skill-eval-production",
      userRoot,
      skillEval: {
        store: f.store,
        runtime: f.runtime,
        binding: { runtime: "admitted-test" },
      },
    });
    try {
      const server = createJsonRpcProtocolServer({
        host,
        build: { commit: null },
        authContext: { transportKind: "unix-socket" },
        sessionPrincipal: async () => ({
          personId: "drafter",
          subject: "subject-drafter",
          expiresAt: Date.now() + 60_000,
          accessToken: "test-token",
          authority: { url: "https://issuer.test", realm: "harness", clientId: "harness-center" },
        }),
        emit: async () => undefined,
      });
      const request = (id: number, method: string, params: Record<string, unknown>) =>
        server.handle({ jsonrpc: "2.0", id, method, params });
      const hello = await request(1, "protocol.hello", { protocolVersion: currentDaemonProtocolVersion });
      assert.equal((hello as { result?: { ok?: boolean } }).result?.ok, true);
      const added = await request(2, "daemon.skillEval.case.add", {
        skillId: "report",
        id: "production-case",
        input: "production input",
        hidden: true,
      });
      assert.equal((added as { result?: { ok?: boolean } }).result?.ok, true);
      const listed = await request(3, "daemon.skillEval.cases.list", { skillId: "report" });
      const rows = (listed as { result?: { cases?: readonly { id: string; input: string | null }[] } }).result?.cases;
      assert.equal(rows?.find((row) => row.id === "production-case")?.input, null);
      const run = await request(4, "daemon.skillEval.run", { skillId: "report", version: "1.0.0" });
      assert.equal((run as { result?: { ok?: boolean } }).result?.ok, true);
      assert.equal(f.calls.length, 3);
      server.close();
    } finally {
      await host.close();
    }
  } finally {
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("keeps case creation append-only and rejects duplicate ids", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-eval-"));
  try {
    const f = fixture();
    const runner = new SkillEvalRunner(f.store, f.runtime, {
      runRoot: root,
      binding: { runtime: "local" },
      clock: () => new Date("2026-10-31T00:00:02.000Z"),
    });
    await assert.rejects(
      runner.addCase({ principalId: "operator", role: "operator" }, "report", { id: "public", input: "new" }),
      (error: unknown) => (error as { readonly code?: string }).code === "CONFLICT",
    );
    const added = await runner.addCase({ principalId: "operator", role: "operator" }, "report", {
      id: "new",
      input: "new",
      hidden: true,
    });
    assert.equal(added.input, "new");
    assert.equal(f.cases.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runs every case in a contained sandbox, releases slots, and emits a gate witness", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-eval-"));
  try {
    const f = fixture();
    const runner = new SkillEvalRunner(f.store, f.runtime, {
      runRoot: root,
      binding: { runtime: "local", model: "test-model" },
      queue: f.queue,
      clock: () => new Date("2026-10-31T00:00:03.000Z"),
      nextEvaluationId: () => "eval-1",
    });
    const result = await runner.run({ principalId: "reviewer", role: "reviewer", canReview: true }, "report", "1.0.0");
    assert.equal(result.gateStatus, "passed");
    assert.equal(result.witness.result, "pass");
    assert.equal(result.passed, 2);
    assert.equal(f.evaluations.length, 1);
    assert.equal(f.releases.length, 2);
    assert.equal(f.calls.length, 2);
    for (const call of f.calls) {
      assert.equal(path.relative(root, call.cwd).startsWith("skill-eval"), true);
      assert.match(call.prompt, /platform skill evaluation/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("records an incomplete runtime as a failed case and still releases its slot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "skill-eval-"));
  try {
    const f = fixture();
    const runner = new SkillEvalRunner(
      f.store,
      { dispatch: async () => ({ status: "failed", error: "provider unavailable" }) },
      {
        runRoot: root,
        binding: { runtime: "local" },
        queue: f.queue,
        nextEvaluationId: () => "eval-2",
      },
    );
    const result = await runner.run({ principalId: "operator", role: "operator" }, "report", "1.0.0", {
      threshold: 0.5,
    });
    assert.equal(result.result, "fail");
    assert.equal(
      result.cases.every((item) => item.pass === false),
      true,
    );
    assert.equal(f.releases.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
