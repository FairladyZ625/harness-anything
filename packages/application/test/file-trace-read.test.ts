// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  extractReferencedCodePaths,
  GIT_HISTORY_FORMAT,
  normalizeTraceTargetPath,
  parseGitHistory,
  selectPassiveTraceContext,
  traceFileCausalHistory,
  traceModulePrefixes,
  type GitHistoryPort,
  type TraceProjection,
} from "../src/queries/file-trace-read.ts";

const TASK_A = "task_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  TASK_B = "task_bbbbbbbbbbbbbbbbbbbbbbbbbb",
  TASK_C = "task_cccccccccccccccccccccccccc",
  MERGE = "1".repeat(40),
  SQUASH = "2".repeat(40),
  PARENT = "3".repeat(40),
  PATH = "packages/daemon/src/daemon-host/fact-observed-commit.ts";

const cut = (revision = 7) => ({ status: "ready" as const, watermark: revision, sourceRevision: revision });

function decision(decisionId: string, state: string, modules: readonly string[], whyNot = "") {
  return {
    decisionId,
    title: `${decisionId} title`,
    state,
    question: "q",
    appliesTo: { modules, productLines: [] },
    chosen: [{ id: "CH1", text: `${decisionId} chosen` }],
    rejected: whyNot ? [{ id: "RJ1", text: "static anchors", whyNot }] : [],
    claims: [],
  };
}

function factRow(factId: string, evidenceSource: string, extra: Record<string, unknown> = {}) {
  return {
    ref: `fact/${factId}`,
    factId,
    statement: `${factId} statement`,
    evidenceSource,
    domainTypes: ["architecture.invariant"],
    archived: false,
    invalidated: false,
    ...extra,
  };
}

function gitLog(records: readonly { sha: string; parents: string; subject: string; files: readonly string[] }[]) {
  assert.equal(GIT_HISTORY_FORMAT, "%x1e%H%x1f%P%x1f%s");
  return records.map((r) => `\x1e${r.sha}\x1f${r.parents}\x1f${r.subject}\n\n${r.files.join("\n")}\n`).join("");
}

function fixture(options: { readonly revision?: (call: string) => number } = {}) {
  const calls: { method: string; args: unknown }[] = [],
    at = (method: string) => cut(options.revision?.(method) ?? 7);
  const projection = {
    readCut: () => at("readCut"),
    readTaskIndex: (query: { taskIds?: string[]; submissionCommitShas?: string[] }) => {
      calls.push({ method: "readTaskIndex", args: query });
      const rows = [
        { taskId: TASK_A, title: "Restore observed commit", status: "done", packagePath: "tasks/a" },
        {
          taskId: TASK_B,
          title: "Squashed fix",
          status: "done",
          packagePath: "tasks/b",
          submissionCommitShas: [SQUASH],
        },
        { taskId: TASK_C, title: "Concurrent edit", status: "active", packagePath: "tasks/c" },
      ];
      return {
        ...at("readTaskIndex"),
        rows: query.submissionCommitShas
          ? rows.filter((row) => row.submissionCommitShas?.some((sha) => query.submissionCommitShas!.includes(sha)))
          : rows.filter((row) => query.taskIds?.includes(row.taskId)),
      };
    },
    readTaskRelationsByTargets: (refs: readonly string[], type: string) => {
      calls.push({ method: "readTaskRelationsByTargets", args: { refs, type } });
      return {
        ...at("readTaskRelationsByTargets"),
        rows: refs.includes(`task/${TASK_A}`)
          ? [
              {
                sourceRef: "decision/dec_LINEAGE/CH1",
                targetRef: `task/${TASK_A}`,
                state: "active",
                direction: "directed",
              },
            ]
          : [],
      };
    },
    listDecisions: (filters: Record<string, unknown>) => {
      calls.push({ method: "listDecisions", args: filters });
      return {
        ...at("listDecisions"),
        decisions: [
          decision("dec_MODULE", "in_effect", ["packages/daemon/src/"], "Static file anchors rot."),
          decision("dec_PLAIN", "in_effect", ["packages/daemon"]),
        ],
      };
    },
    readDecisions: (ids: readonly string[], withBody?: boolean) => {
      calls.push({ method: "readDecisions", args: { ids, withBody } });
      return { ...at("readDecisions"), decisions: [decision("dec_LINEAGE", "superseded", [])] };
    },
    searchFacts: (filters: Record<string, unknown>) => {
      calls.push({ method: "searchFacts", args: filters });
      return {
        ...at("searchFacts"),
        facts: filters.evidenceSourcePaths
          ? [factRow("F-00000001", `${PATH}:15-29`), factRow("F-00000002", PATH, { archived: true })]
          : [factRow("F-00000003", "elsewhere", { observedCommit: MERGE })],
      };
    },
  } as unknown as TraceProjection;
  return { projection, calls };
}

function port(overrides: Partial<GitHistoryPort> = {}) {
  const invocations: { method: string; input: unknown }[] = [];
  const gitHistory: GitHistoryPort = {
    readPathHistory: (input) => {
      invocations.push({ method: "readPathHistory", input });
      return {
        availability: "available",
        stdout: gitLog([
          {
            sha: MERGE,
            parents: `${PARENT} ${"4".repeat(40)}`,
            subject: `Merge pull request #3809 from o/${TASK_A}`,
            files: [PATH],
          },
          { sha: SQUASH, parents: PARENT, subject: "fix(daemon): keep observed commit (#3805)", files: [PATH] },
        ]),
      };
    },
    readBranchCollisions: (input) => {
      invocations.push({ method: "readBranchCollisions", input });
      return {
        availability: "available",
        stdout: `\x1e${"5".repeat(40)}\x1frefs/heads/${TASK_C}\n\x1e${"6".repeat(40)}\x1frefs/heads/${TASK_C}\n\x1e${"7".repeat(40)}\x1fHEAD\n`,
      };
    },
    ...overrides,
  };
  return { gitHistory, invocations };
}

test("trace paths normalize to repository-relative POSIX form and reject escapes", () => {
  assert.deepEqual(normalizeTraceTargetPath("packages\\daemon\\src\\a.ts"), {
    ok: true,
    path: "packages/daemon/src/a.ts",
  });
  assert.deepEqual(normalizeTraceTargetPath("  ././tools/gates/x.mjs "), { ok: true, path: "tools/gates/x.mjs" });
  for (const raw of [
    "",
    "   ",
    "../outside.ts",
    "a/../b.ts",
    "/etc/passwd",
    "C:\\evil.ts",
    "c:/evil.ts",
    "a//b.ts",
    "a/./b.ts",
    42,
    null,
    "a\0b",
  ]) {
    const result = normalizeTraceTargetPath(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    if (!result.ok) assert.equal(result.code, "invalid_trace_path");
  }
  assert.deepEqual(traceModulePrefixes("packages/storage/src/pg/x.ts"), [
    "packages",
    "packages/storage",
    "packages/storage/src",
    "packages/storage/src/pg",
    "packages/storage/src/pg/x.ts",
  ]);
});

test("plan path extraction deduplicates, strips line anchors, skips ledger paths and caps at five", () => {
  const plan = [
    "Edit `packages/daemon/src/a.ts:12-30` and packages/daemon/src/a.ts#L4 again.",
    "Read `harness/tasks/x/task_plan.md`, https://example.com/x.ts and `tasks/y/z.md`.",
    "Then `packages\\storage\\src\\b.ts`, tools/gates/c.mjs, (packages/kernel/src/d.ts), `packages/cli/src/e.ts`,",
    "`packages/application/src/f.ts` and `packages/gui/src/g.tsx`.",
  ].join("\n");
  assert.deepEqual(extractReferencedCodePaths(plan), [
    "packages/daemon/src/a.ts",
    "packages/storage/src/b.ts",
    "tools/gates/c.mjs",
    "packages/kernel/src/d.ts",
    "packages/cli/src/e.ts",
  ]);
  assert.deepEqual(extractReferencedCodePaths(""), []);
});

test("parseGitHistory keeps full SHAs, PR numbers, task ids and touched files", () => {
  const [merge, squash] = parseGitHistory(
    port().gitHistory.readPathHistory({ paths: [PATH], maxCommits: 2 }).stdout as string,
  );
  assert.equal(merge?.commitSha, MERGE);
  assert.equal(merge?.prNumber, 3809);
  assert.equal(merge?.taskId, TASK_A);
  assert.deepEqual(merge?.files, [PATH]);
  assert.equal(squash?.prNumber, 3805);
  assert.equal(squash?.taskId, null);
});

test("ha trace resolves tasks by merge subject and by indexed submission SHA, with redlines, facts and collisions", () => {
  const { projection, calls } = fixture(),
    { gitHistory, invocations } = port(),
    result = traceFileCausalHistory({
      projection,
      path: "packages\\daemon\\src\\daemon-host\\fact-observed-commit.ts",
      limit: "15",
      gitHistory,
    });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.path, PATH);
  assert.deepEqual(result.git, { availability: "available" });
  assert.deepEqual(result.projectionCut, cut());
  assert.deepEqual(
    result.touchHistory.map((touch) => [touch.prNumber, touch.taskId, touch.taskStatus]),
    [
      [3809, TASK_A, "done"],
      [3805, TASK_B, "done"],
    ],
  );
  assert.deepEqual(
    result.decisions.map((entry) => [entry.decisionId, entry.state, entry.viaTaskIds, entry.viaModulePrefix]),
    [
      ["dec_MODULE", "in_effect", [], "packages/daemon/src"],
      ["dec_PLAIN", "in_effect", [], "packages/daemon"],
      ["dec_LINEAGE", "superseded", [TASK_A], null],
    ],
  );
  assert.deepEqual(result.decisions[0]?.rejected, [
    { id: "RJ1", summary: "static anchors", whyNot: "Static file anchors rot." },
  ]);
  assert.deepEqual(
    result.facts.map((entry) => [entry.factId, entry.matchReason]),
    [
      ["F-00000001", "evidence_source"],
      ["F-00000003", "observed_commit"],
    ],
    "archived facts never surface",
  );
  assert.deepEqual(result.activeTasks, [
    {
      taskId: TASK_C,
      title: "Concurrent edit",
      status: "active",
      branch: TASK_C,
      commits: 2,
      matchReason: "branch_diff",
    },
  ]);
  // Exactly two Git processes for `ha trace`: one batched history and one collision radar.
  assert.deepEqual(
    invocations.map((entry) => entry.method),
    ["readPathHistory", "readBranchCollisions"],
  );
  assert.deepEqual(invocations[0]?.input, { paths: [PATH], maxCommits: 15 });
  // Every projection read is bounded: an id/SHA probe, or an explicit page with no bodies.
  for (const call of calls) {
    if (call.method === "readTaskIndex") {
      const query = call.args as { taskIds?: unknown[]; submissionCommitShas?: unknown[] };
      assert.ok(query.taskIds !== undefined || query.submissionCommitShas !== undefined, JSON.stringify(query));
    }
    if (call.method === "listDecisions")
      assert.deepEqual(call.args, {
        state: "in_effect",
        modulePrefixes: traceModulePrefixes(PATH),
        withBody: false,
        limit: 20,
      });
    if (call.method === "readDecisions") assert.equal((call.args as { withBody?: boolean }).withBody, false);
    if (call.method === "searchFacts") {
      const filters = call.args as Record<string, unknown>;
      assert.equal(filters.limit, 20);
      assert.equal(filters.query, undefined, "no unindexed full-text scan");
    }
  }
  assert.deepEqual(
    calls.find((call) => call.method === "readTaskIndex" && "submissionCommitShas" in (call.args as object))?.args,
    { submissionCommitShas: [SQUASH, PARENT] },
  );
});

test("git failures surface as structured unavailability while projection-only lookups still answer", () => {
  const { projection } = fixture(),
    { gitHistory } = port({
      readPathHistory: () => ({
        availability: "unavailable",
        reason: "git_log_failed",
        message: "git log failed (exit 128): fatal: bad object HEAD",
      }),
      readBranchCollisions: () => ({ availability: "unavailable", reason: "git_log_failed", message: "same" }),
    }),
    result = traceFileCausalHistory({ projection, path: PATH, gitHistory });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.git, {
    availability: "unavailable",
    reason: "git_log_failed",
    message: "git log failed (exit 128): fatal: bad object HEAD",
  });
  assert.deepEqual(result.touchHistory, []);
  assert.deepEqual(result.activeTasks, []);
  assert.deepEqual(
    result.decisions.map((entry) => entry.decisionId),
    ["dec_MODULE", "dec_PLAIN"],
  );
  const centerCell = traceFileCausalHistory({ projection, path: PATH, gitHistory: null });
  assert.equal(
    centerCell.ok && centerCell.git.availability === "unavailable" && centerCell.git.reason,
    "git_worktree_unavailable",
  );
});

test("invalid paths and limits are rejected before any Git process or projection read", () => {
  const { projection, calls } = fixture(),
    { gitHistory, invocations } = port();
  for (const [path, limit] of [
    ["../escape.ts", undefined],
    ["C:\\evil.ts", undefined],
    [PATH, 0],
    [PATH, 201],
    [PATH, "1.5"],
  ] as const) {
    const result = traceFileCausalHistory({ projection, path, limit, gitHistory });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "invalid_trace_path");
  }
  assert.equal(invocations.length, 0);
  assert.equal(calls.length, 0);
});

test("reads from different projection cuts fail closed", () => {
  const { projection } = fixture({ revision: (method) => (method === "searchFacts" ? 8 : 7) }),
    { gitHistory } = port();
  assert.throws(
    () => traceFileCausalHistory({ projection, path: PATH, gitHistory }),
    /multiple event projection cuts/u,
  );
});

test("passive dispatch trace batches every plan path into one Git process and dedupes the forward context", () => {
  const { projection } = fixture(),
    { gitHistory, invocations } = port(),
    plan = [
      `\`${PATH}\``,
      "`packages/daemon/src/b.ts` `packages/daemon/src/c.ts` `packages/daemon/src/d.ts`",
      "`packages/daemon/src/e.ts` `packages/daemon/src/f.ts`",
    ].join("\n"),
    selection = selectPassiveTraceContext({
      projection,
      planBody: plan,
      gitHistory,
      excludeDecisionIds: ["dec_PLAIN"],
      excludeFactRefs: ["fact/F-00000003"],
      maxDecisions: 2,
      maxFacts: 3,
    });
  assert.ok(selection !== null);
  assert.deepEqual(
    invocations.map((entry) => entry.method),
    ["readPathHistory"],
    "dispatch spends at most one Git process (gitProcesses <= 1)",
  );
  assert.equal((invocations[0]?.input as { paths: string[] }).paths.length, 5);
  assert.deepEqual(
    selection.decisions.map((entry) => entry.decisionId),
    ["dec_MODULE"],
    "only in-effect decisions not already in the forward context",
  );
  assert.deepEqual(
    selection.facts.map((entry) => entry.ref),
    ["fact/F-00000001"],
  );
  assert.equal(
    selectPassiveTraceContext({
      projection,
      planBody: "No code paths here.",
      gitHistory,
      excludeDecisionIds: [],
      excludeFactRefs: [],
      maxDecisions: 2,
      maxFacts: 3,
    }),
    null,
  );
  assert.equal(invocations.length, 1, "a plan without code paths spawns no Git process");
});
