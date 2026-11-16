// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runProcessText } from "../src/process-port.ts";
import {
  extractReferencedCodePaths,
  normalizeTraceTargetPath,
  traceFileCausalHistory,
  type TraceCausalProjection,
} from "../src/file-trace-read.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const HISTORICAL_SHA_3805 = "0603933faa35e8c946f9b0bcf6f4ee243d02dfeb";
const HISTORICAL_SHA_3809 = "b3dacc5578e6ca6898087eb483566706ba51f555";
const cut = (revision = 180) => ({ status: "ready" as const, watermark: revision, sourceRevision: revision });

function createMockProjection(sha3805 = HISTORICAL_SHA_3805, sha3809 = HISTORICAL_SHA_3809): TraceCausalProjection {
  return {
    readCut: () => cut(),
    readTaskIndex: (query) => {
      const requested = new Set(query?.taskIds ?? []);
      const allRows = [
        {
          supersededBy: null,
          taskId: "task_899f8c11e8b15af04328a239bf",
          title: "Capture observedCommit on fact record",
          status: "done" as const,
          pinned: false,
          parentTaskId: null,
          workKind: "feat" as const,
          riskTier: "medium" as const,
          urgency: "medium" as const,
          taskClass: "standard" as const,
          packageDisposition: "active" as const,
          packagePath: "tasks/task_899f8c11e8b15af04328a239bf",
          updatedAt: "2026-10-19T12:00:00.000Z",
        },
        {
          supersededBy: null,
          taskId: "task_c91624aa9991224b22edd39472",
          title: "Restore fact-observed-commit under CH4",
          status: "done" as const,
          pinned: false,
          parentTaskId: null,
          workKind: "fix" as const,
          riskTier: "medium" as const,
          urgency: "high" as const,
          taskClass: "standard" as const,
          packageDisposition: "active" as const,
          packagePath: "tasks/task_c91624aa9991224b22edd39472",
          updatedAt: "2026-10-19T15:00:00.000Z",
        },
      ];
      return {
        schema: "task-index-projection/v1",
        ...cut(),
        rows: requested.size > 0 ? allRows.filter((r) => requested.has(r.taskId)) : [],
        warnings: [],
        page: null,
      };
    },
    readTaskRelationsByTargets: (targetRefs, relationType) => ({
      ...cut(),
      rows:
        relationType === "derives" && targetRefs.includes("task/task_c91624aa9991224b22edd39472")
          ? [
              {
                relationId: "rel_ch4",
                workspaceRevision: 100,
                sourceRef: "decision/dec_BB2BCE9F995CD3A126E2918734/CH4",
                targetRef: "task/task_c91624aa9991224b22edd39472",
                relationType: "derives",
                direction: "directed",
                strength: "strong",
                origin: "declared",
                state: "active",
                targetObservedVersion: null,
                currentTargetVersion: null,
                freshness: "current",
                rationale: "CH4 derives the observedCommit capture task",
                ownerRef: "decision/dec_BB2BCE9F995CD3A126E2918734",
                sourcePath: "decisions/decision-dec_BB2BCE9F995CD3A126E2918734/decision.md",
                recordIndex: 0,
              },
            ]
          : [],
    }),
    readRelationQuery: (query) => ({
      ...cut(),
      rows:
        query?.entity === "decision/dec_BB2BCE9F995CD3A126E2918734"
          ? [
              {
                relationId: "rel_ev1",
                workspaceRevision: 101,
                sourceRef: "decision/dec_BB2BCE9F995CD3A126E2918734/C1",
                targetRef: "fact/F-1D626C4E",
                relationType: "evidenced-by",
                direction: "directed",
                strength: "strong",
                origin: "declared",
                state: "active",
                targetObservedVersion: null,
                currentTargetVersion: null,
                freshness: "current",
                rationale: "Evidence for C1",
                ownerRef: "decision/dec_BB2BCE9F995CD3A126E2918734",
                sourcePath: "decisions/decision-dec_BB2BCE9F995CD3A126E2918734/decision.md",
                recordIndex: 1,
              },
              {
                relationId: "rel_ev2",
                workspaceRevision: 102,
                sourceRef: "decision/dec_BB2BCE9F995CD3A126E2918734/C2",
                targetRef: "fact/F-300F8791",
                relationType: "evidenced-by",
                direction: "directed",
                strength: "strong",
                origin: "declared",
                state: "active",
                targetObservedVersion: null,
                currentTargetVersion: null,
                freshness: "current",
                rationale: "Evidence for C2",
                ownerRef: "decision/dec_BB2BCE9F995CD3A126E2918734",
                sourcePath: "decisions/decision-dec_BB2BCE9F995CD3A126E2918734/decision.md",
                recordIndex: 2,
              },
            ]
          : [],
    }),
    readDecisions: (ids) => ({
      ...cut(),
      decisions: ids.includes("dec_BB2BCE9F995CD3A126E2918734")
        ? [
            {
              schema: "decision-row/v1",
              decisionId: "dec_BB2BCE9F995CD3A126E2918734",
              path: "decisions/decision-dec_BB2BCE9F995CD3A126E2918734/decision.md",
              state: "in_effect",
              title: "Retire static code-doc-anchors and adopt observedCommit",
              question: "How should code-to-fact observations anchor to commits?",
              riskTier: "medium",
              urgency: "high",
              vertical: "software/coding",
              preset: "decision-conformance",
              decisionClass: "ordinary",
              appliesTo: { modules: ["packages/daemon/src"], productLines: ["software/coding"] },
              proposer: { executor: null, principal: { personId: "cyrneutron" } },
              arbiter: null,
              proposedAt: "2026-10-19T10:00:00.000Z",
              decidedAt: "2026-10-19T11:00:00.000Z",
              workspaceRevision: 99,
              chosen: [
                {
                  id: "CH4",
                  text: "Capture git HEAD SHA automatically into observedCommit at fact_recorded time",
                },
              ],
              rejected: [
                {
                  id: "RJ3",
                  text: "Maintain static code-doc-anchors.json manually",
                  whyNot: "Static file anchors cause merge conflicts and false staleness alerts.",
                },
              ],
              claims: [
                { id: "C1", text: "observedCommit works without anchor files", loadBearing: true, fulfillment: "fact" },
              ],
              provenance: [],
              judgmentConsents: [],
              reviews: [],
              reviewResponses: [],
              reviewOverrides: [],
              relations: [],
              body: null,
              capabilities: [],
              claimsOpen: false,
            },
          ]
        : [],
    }),
    searchFacts: () => ({
      ...cut(),
      facts: [
        {
          schema: "fact-row/v1",
          ref: "fact/F-1D626C4E",
          factId: "F-1D626C4E",
          statement: "Static code-doc-anchors generated frequent merge conflicts.",
          evidenceSource: "packages/daemon/src/fact-observed-commit.ts",
          observedAt: "2026-10-19T13:00:00.000Z",
          observedCommit: sha3809,
          confidence: "high",
          domainTypes: ["architecture.invariant"],
          memoryClass: "semantic",
          memoryTags: [],
          provenance: [],
          actor: { executor: null, principal: { personId: "cyrneutron" } },
          source: "local",
          occurredAt: "2026-10-19T13:00:00.000Z",
          workspaceRevision: 101,
          state: "standing",
          invalidated: false,
          archived: false,
        },
        {
          schema: "fact-row/v1",
          ref: "fact/F-300F8791",
          factId: "F-300F8791",
          statement: "fact-observed-commit captures HEAD commit cleanly during fact_recorded.",
          evidenceSource: "packages/daemon/src/fact-observed-commit.ts",
          observedAt: "2026-10-19T14:04:42.000Z",
          observedCommit: sha3805,
          confidence: "high",
          domainTypes: ["architecture.invariant"],
          memoryClass: "semantic",
          memoryTags: [],
          provenance: [],
          actor: { executor: null, principal: { personId: "cyrneutron" } },
          source: "local",
          occurredAt: "2026-10-19T14:04:42.000Z",
          workspaceRevision: 102,
          state: "standing",
          invalidated: false,
          archived: false,
        },
      ],
    }),
  };
}

function hasReachableDeepHistory(rootDir: string, sha: string): boolean {
  try {
    const isShallow = runProcessText("git", ["rev-parse", "--is-shallow-repository"], rootDir).trim();
    if (isShallow !== "false") return false;
    runProcessText("git", ["merge-base", "--is-ancestor", sha, "HEAD"], rootDir);
    return true;
  } catch {
    return false;
  }
}

function createShallowFallbackGitRepo(): {
  readonly rootDir: string;
  readonly sha3805: string;
  readonly sha3809: string;
  cleanup(): void;
} {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "ha-trace-golden-"));
  const targetFile = path.join(tempRoot, "packages", "daemon", "src", "fact-observed-commit.ts");
  mkdirSync(path.dirname(targetFile), { recursive: true });
  runProcessText("git", ["init"], tempRoot);
  const commit = (content: string, message: string): string => {
    writeFileSync(targetFile, content, "utf8");
    runProcessText("git", ["add", "."], tempRoot);
    runProcessText(
      "git",
      ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-m", message],
      tempRoot,
    );
    return runProcessText("git", ["rev-parse", "HEAD"], tempRoot).trim();
  };
  const sha3805 = commit(
    "export const step = 1;\n",
    "Merge pull request #3805 from FairladyZ625/task_899f8c11e8b15af04328a239bf",
  );
  commit("export const step = 2;\n", "Merge pull request #3808 from FairladyZ625/revert-3805-fact-on-demand");
  const sha3809 = commit(
    "export const step = 3;\n",
    "Merge pull request #3809 from FairladyZ625/task_c91624aa9991224b22edd39472",
  );
  return {
    rootDir: tempRoot,
    sha3805,
    sha3809,
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}

test("Test 1 (Golden Penetration): traces real git history of fact-observed-commit.ts with Decision/Rejected/Facts", () => {
  const sampleLog = [
    `${HISTORICAL_SHA_3809}|3ba54a2ce827c85f429f78f5605dd525ee9193ba 4f8fbb7fc2d6d7a86365e0fd4f22e43eb45f64ab|Merge pull request #3809 from FairladyZ625/task_c91624aa9991224b22edd39472`,
    `f23174707e0aaed8a7679f1f65f419057d1dbf96|${HISTORICAL_SHA_3805} 775b171e8aad6c40581fee36d043b68654b13685|Merge pull request #3808 from FairladyZ625/revert-3805-fact-on-demand`,
    `${HISTORICAL_SHA_3805}|7861b315b1956af8c5008a246d11eb01633eb28d|Merge pull request #3805 from FairladyZ625/task_899f8c11e8b15af04328a239bf`,
  ].join("\n");
  const kernelResult = traceFileCausalHistory({
    projection: createMockProjection(),
    rootDir: REPO_ROOT,
    path: "packages\\daemon\\src\\fact-observed-commit.ts",
    includeActiveRadar: false,
    readGitLog: () => sampleLog,
  });
  assert.equal(kernelResult.ok, true);

  const targetRepo = hasReachableDeepHistory(REPO_ROOT, HISTORICAL_SHA_3805)
    ? { rootDir: REPO_ROOT, sha3805: HISTORICAL_SHA_3805, sha3809: HISTORICAL_SHA_3809, cleanup: undefined }
    : createShallowFallbackGitRepo();
  const realProjection = createMockProjection(targetRepo.sha3805, targetRepo.sha3809);

  try {
    const coldResult = traceFileCausalHistory({
      projection: realProjection,
      rootDir: targetRepo.rootDir,
      path: "packages\\daemon\\src\\fact-observed-commit.ts",
      includeActiveRadar: false,
    });

    const warmResult = traceFileCausalHistory({
      projection: realProjection,
      rootDir: targetRepo.rootDir,
      path: "packages/daemon/src/fact-observed-commit.ts",
      includeActiveRadar: false,
    });

    assert.equal(coldResult.ok, true);
    assert.equal(warmResult.ok, true);
    if (!warmResult.ok) return;

    assert.equal(warmResult.schema, "file-trace-read/v1");
    assert.equal(warmResult.path, "packages/daemon/src/fact-observed-commit.ts");

    const prs = warmResult.touchHistory.map((t) => t.prNumber);
    assert.ok(prs.includes(3805), `expected PR #3805 in ${JSON.stringify(prs)}`);
    assert.ok(prs.includes(3808), `expected PR #3808 in ${JSON.stringify(prs)}`);
    assert.ok(prs.includes(3809), `expected PR #3809 in ${JSON.stringify(prs)}`);

    const taskIds = warmResult.touchHistory.map((t) => t.taskId);
    assert.ok(taskIds.includes("task_899f8c11e8b15af04328a239bf"));
    assert.ok(taskIds.includes("task_c91624aa9991224b22edd39472"));

    assert.equal(warmResult.decisions.length, 1);
    assert.equal(warmResult.decisions[0]!.decisionId, "dec_BB2BCE9F995CD3A126E2918734");
    assert.equal(warmResult.decisions[0]!.chosen[0]?.id, "CH4");
    assert.equal(warmResult.decisions[0]!.rejected[0]?.id, "RJ3");
    assert.match(warmResult.decisions[0]!.rejected[0]?.whyNot ?? "", /merge conflicts/u);

    const factIds = warmResult.facts.map((f) => f.factId);
    assert.ok(factIds.includes("F-1D626C4E"));
    assert.ok(factIds.includes("F-300F8791"));
  } finally {
    targetRepo.cleanup?.();
  }
});

test("Test 2 (Graceful Degradation): zero-history path, unborn HEAD git repo, and non-git dir return empty arrays", () => {
  const emptyProjection: TraceCausalProjection = {
    readCut: () => cut(),
    readTaskIndex: () => ({ schema: "task-index-projection/v1", ...cut(), rows: [], warnings: [], page: null }),
    searchFacts: () => ({ ...cut(), facts: [] }),
  };

  // Case A: non-existent path in real repository
  const missingFile = traceFileCausalHistory({
    projection: emptyProjection,
    rootDir: REPO_ROOT,
    path: "src/brand-new-file.ts",
    includeActiveRadar: true,
  });
  assert.equal(missingFile.ok, true);
  if (missingFile.ok) {
    assert.deepEqual(missingFile.touchHistory, []);
    assert.deepEqual(missingFile.decisions, []);
    assert.deepEqual(missingFile.facts, []);
    assert.deepEqual(missingFile.activeTasks, []);
  }

  // Case B: non-git temporary directory + Case C: unborn HEAD git init directory
  const tempRoot = mkdtempSync(path.join(tmpdir(), "ha-trace-empty-"));
  try {
    const nonGit = traceFileCausalHistory({
      projection: emptyProjection,
      rootDir: tempRoot,
      path: "src/new.ts",
    });
    assert.equal(nonGit.ok, true);
    if (nonGit.ok) assert.deepEqual(nonGit.touchHistory, []);

    runProcessText("git", ["init"], tempRoot);
    const unborn = traceFileCausalHistory({
      projection: emptyProjection,
      rootDir: tempRoot,
      path: "src/new.ts",
    });
    assert.equal(unborn.ok, true);
    if (unborn.ok) assert.deepEqual(unborn.touchHistory, []);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Test 3 (Security & Path Validation): rejects empty, absolute, Windows drive, and .. paths without spawning git", () => {
  let gitCalls = 0;
  const projection: TraceCausalProjection = {
    readCut: () => cut(),
  };
  for (const badPath of [
    "",
    "   ",
    "../outside.ts",
    "packages/../../secret.ts",
    "/etc/passwd",
    "C:\\Windows\\System32\\cmd.exe",
    "foo\0bar.ts",
  ]) {
    const result = traceFileCausalHistory({
      projection,
      rootDir: REPO_ROOT,
      path: badPath,
      readGitLog: () => {
        gitCalls += 1;
        return "";
      },
    });
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(badPath)}`);
    if (!result.ok) assert.equal(result.code, "invalid_trace_path");
  }
  assert.equal(gitCalls, 0, "invalid paths must be rejected before invoking git");

  // Windows backslashes normalize cleanly
  const winNorm = normalizeTraceTargetPath(".\\packages\\daemon\\src\\fact-observed-commit.ts");
  assert.deepEqual(winNorm, { ok: true, path: "packages/daemon/src/fact-observed-commit.ts" });
});

test("extractReferencedCodePaths deduplicates, skips harness/ledger refs, and caps at 5 paths", () => {
  const md = [
    "See `packages/daemon/src/fact-observed-commit.ts#L12-L20` and `harness/tasks/task_1/task_plan.md`.",
    "Also inspect decision/dec_1/C1, packages\\daemon\\src\\dispatch-causal-context.ts:44,",
    "and `packages/daemon/src/fact-observed-commit.ts` (duplicate), `packages/kernel/src/ports/task-projection.ts`,",
    "`tools/gates/ontology-closure.mjs`, `packages/cli/src/index.ts`, `packages/storage/src/projection/fact-event-projection.ts`.",
  ].join("\n");
  assert.deepEqual(extractReferencedCodePaths(md, 5), [
    "packages/daemon/src/fact-observed-commit.ts",
    "packages/daemon/src/dispatch-causal-context.ts",
    "packages/kernel/src/ports/task-projection.ts",
    "tools/gates/ontology-closure.mjs",
    "packages/cli/src/index.ts",
  ]);
});
