// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import {
  deriveRelationId,
  formatFactFlowRecord,
  formatRelationFlowRecord,
  makeJournaledWriteCoordinator,
  sha256Text,
  type EntityRelationRecord,
  type FactRecord,
  type WriteCoordinator
} from "../../kernel/src/index.ts";
import {
  buildDocSyncReport as daemonBuildDocSyncReport,
  makeDocSyncService as makeDaemonDocSyncService,
  validateDocSyncSubmitRequest as validateDaemonDocSyncSubmitRequest
} from "@harness-anything/daemon";
import { cliDaemonServiceHostServices } from "../src/composition/daemon-service-host-services.ts";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const registryBody = readFileSync(path.join(repoRoot, "tools/write-road-registry.json"), "utf8");
const commitAuthor = { name: "Harness Test", email: "harness@example.test" };
const buildDocSyncReport = (rootInput: Parameters<typeof daemonBuildDocSyncReport>[0]) =>
  daemonBuildDocSyncReport(rootInput, cliDaemonServiceHostServices.docSync);
const makeDocSyncService = (
  options: Omit<Parameters<typeof makeDaemonDocSyncService>[0], "hostServices">
) => makeDaemonDocSyncService({ ...options, hostServices: cliDaemonServiceHostServices.docSync });
const validateDocSyncSubmitRequest = (
  input: Omit<Parameters<typeof validateDaemonDocSyncSubmitRequest>[0], "hostServices">
) => validateDaemonDocSyncSubmitRequest({ ...input, hostServices: cliDaemonServiceHostServices.docSync });

test("doc sync preview and submit validator classify same-extension prose and frontmatter consistently", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskRoot, taskId }) => {
    const planPath = path.join(taskRoot, "task_plan.md");
    const indexPath = path.join(taskRoot, "INDEX.md");
    writeFileSync(planPath, planBody("Updated prose."), "utf8");
    writeFileSync(indexPath, taskIndex({ urgency: "high" }), "utf8");

    const report = buildDocSyncReport(rootDir);
    assert.equal(report.candidateBlobs.some((entry) => entry.path.endsWith("/task_plan.md")), true);
    assert.equal(report.forbiddenTouches.some((touch) => touch.path.endsWith("/INDEX.md")), true);
    assert.equal(report.readyToSubmitPreview, false);

    const validation = validateDocSyncSubmitRequest({
      rootInput: rootDir,
      request: submitRequest({
        baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
        intentId: "intent-preview-parity",
        changes: [
          inlineChange(`tasks/${taskId}/task_plan.md`, planBody("Original prose."), planBody("Updated prose.")),
          inlineChange(`tasks/${taskId}/INDEX.md`, taskIndex({ urgency: "medium" }), taskIndex({ urgency: "high" }))
        ]
      })
    });

    assert.equal(validation.acceptedChanges.some((entry) => entry.path.endsWith("/task_plan.md")), true);
    assert.equal(validation.forbiddenTouches.some((touch) => touch.path.endsWith("/INDEX.md")), true);
    assert.equal(validation.ok, false);
  });
});

test("doc sync report treats a missing write-road registry as empty coverage instead of crashing", async () => {
  // Regression for #644: consumer repos have no dogfood write-road registry, so the
  // unguarded readFileSync in loadRegistry crashed every decision command (incl. --dry-run).
  await withHarnessFixture(async ({ rootDir, taskRoot }) => {
    writeFileSync(path.join(taskRoot, "task_plan.md"), "# Plan\n\nConsumer edit.\n", "utf8");
    const report = buildDocSyncReport(rootDir);
    // Inert: no crash, empty coverage, and no manufactured warnings/touches.
    assert.equal(report.registry.sha256, sha256Text(""));
    assert.equal(report.dirtyFiles.length, 0);
    assert.deepEqual(report.forbiddenTouches, []);
    assert.deepEqual(report.unresolvedTouches, []);
    assert.equal(report.readyToSubmitPreview, true);
  }, { writeRegistry: false });
});

test("doc sync submit accepts pure task prose and commits with hermetic author", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskId }) => {
    const captured: Array<Record<string, unknown>> = [];
    const service = makeDocSyncService({ rootDir, coordinator: capturingAttributedCoordinator(rootDir, captured) });
    const baseLedgerSha = git(harnessRoot, "rev-parse", "HEAD");
    const result = await service.submit(submitRequest({
      baseLedgerSha,
      intentId: "intent-prose",
      changes: [
        inlineChange(`tasks/${taskId}/task_plan.md`, planBody("Original prose."), planBody("Updated prose."))
      ]
    }));

    assert.equal(result.ok, true);
    assert.equal(result.status, "accepted");
    assert.notEqual(result.appliedLedgerSha, baseLedgerSha);
    assert.match(readFileSync(path.join(harnessRoot, "tasks", taskId, "task_plan.md"), "utf8"), /Updated prose/u);
    assert.equal(git(harnessRoot, "status", "--short"), "");
    assert.equal(git(harnessRoot, "log", "-1", "--format=%an <%ae>"), "Harness Test <harness@example.test>");
    const record = captured.find((entry) => entry.kind === "doc_sync_submit");
    assert.equal(record?.schema, "write-journal/v2");
    assert.deepEqual(record?.actor, {
      principal: { kind: "person", personId: "person_test" },
      executor: { kind: "agent", id: "codex-test" }
    });
    assert.deepEqual(record?.principalSource, {
      kind: "local-configured",
      authority: "harness.yaml",
      authoritySha256: `sha256:${"0".repeat(64)}`
    });
    assert.equal(record?.executorSource, "client-asserted");
  });
});

test("doc sync submit accepts undeclared sections in task host prose", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskId }) => {
    const service = makeDocSyncService({ rootDir, coordinator: attributedCoordinator(rootDir) });
    const base = planBody("Original prose.");
    const next = `${base}\n## 2026-07-21 Review Addendum\n\nNewly discovered requirement.\n`;
    const result = await service.submit(submitRequest({
      baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
      intentId: "intent-task-plan-addendum",
      changes: [inlineChange(`tasks/${taskId}/task_plan.md`, base, next)]
    }));

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(readFileSync(path.join(harnessRoot, "tasks", taskId, "task_plan.md"), "utf8"), /Review Addendum/u);
  });
});

test("doc sync rejects renamed task host-prose skeleton sections", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskId }) => {
    const base = planBody("Original prose.");
    const validation = validateDocSyncSubmitRequest({
      rootInput: rootDir,
      request: submitRequest({
        baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
        intentId: "intent-task-plan-renamed-skeleton",
        changes: [inlineChange(`tasks/${taskId}/task_plan.md`, base, base.replace("## Goal", "## Purpose"))]
      })
    });

    assert.equal(validation.ok, false);
    assert.match(validation.unresolvedTouches[0]?.reason ?? "", /SEMANTIC_DIFF_AMBIGUOUS:section identity changed/u);
  });
});

test("doc sync keeps decision documents strict about undeclared sections", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot }) => {
    const decisionPath = "decisions/decision-dec_TEST/decision.md";
    const decisionBase = "# Decision\n\n## Rationale\n\nOriginal rationale.\n";
    mkdirSync(path.join(harnessRoot, "decisions", "decision-dec_TEST"), { recursive: true });
    writeFileSync(path.join(harnessRoot, decisionPath), decisionBase, "utf8");
    git(harnessRoot, "add", decisionPath);
    gitCommit(harnessRoot, "seed canonical decision");
    const validation = validateDocSyncSubmitRequest({
      rootInput: rootDir,
      request: submitRequest({
        baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
        intentId: "intent-decision-addendum",
        changes: [inlineChange(decisionPath, decisionBase, `${decisionBase}\n## Addendum\n\nUndeclared.\n`)]
      })
    });

    assert.equal(validation.ok, false);
    assert.match(validation.unresolvedTouches[0]?.reason ?? "", /SEMANTIC_DIFF_REQUIRED:undeclared section/u);
  });
});

test("doc sync candidate tree compiles prose plus hosted facts and relation in one save", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskRoot, taskId }) => {
    writeFileSync(path.join(taskRoot, "facts.md"), factsBody(""), "utf8");
    git(harnessRoot, "add", "tasks");
    gitCommit(harnessRoot, "seed empty facts region");
    const first = factRecord("F-AAAA1111");
    const second = factRecord("F-BBBB2222");
    const relationInput = {
      source: `fact/${taskId}/${second.fact_id}`,
      target: `fact/${taskId}/${first.fact_id}`,
      type: "supersedes-fact",
      strength: "strong",
      direction: "directed",
      origin: "declared",
      rationale: "The second observation supersedes the first.",
      state: "active"
    } satisfies Omit<EntityRelationRecord, "relation_id">;
    const relation = { ...relationInput, relation_id: deriveRelationId(relationInput) };
    const nextFacts = factsBody([
      formatFactFlowRecord(first),
      formatFactFlowRecord(second),
      "relations:",
      formatRelationFlowRecord(relation)
    ].join("\n"));
    const validation = validateDocSyncSubmitRequest({
      rootInput: rootDir,
      request: submitRequest({
        baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
        intentId: "intent-prose-fact-relation",
        changes: [
          inlineChange(`tasks/${taskId}/task_plan.md`, planBody("Original prose."), planBody("Updated prose.")),
          inlineChange(`tasks/${taskId}/facts.md`, factsBody(""), nextFacts)
        ]
      })
    });

    assert.equal(validation.ok, true, JSON.stringify(validation));
    const semanticRows = validation.semanticMutationPlan.mutations.map((mutation) => [
      mutation.entityKind, mutation.action, mutation.identity
    ] as const).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const expectedRows = [
      ["fact", "create", { taskId, factId: first.fact_id }],
      ["fact", "invalidate", { taskId, factId: first.fact_id }],
      ["fact", "create", { taskId, factId: second.fact_id }],
      ["relation", "create", { relationId: relation.relation_id }],
      ["task", "document", { taskId }]
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    assert.deepEqual(semanticRows, expectedRows);
  });
});

test("doc sync submit ingests a pre-applied working-tree prose edit through the coordinator", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskRoot, taskId }) => {
    const nextBody = planBody("Updated before submit.");
    writeFileSync(path.join(taskRoot, "task_plan.md"), nextBody, "utf8");
    const service = makeDocSyncService({ rootDir, coordinator: attributedCoordinator(rootDir) });
    const result = await service.submit(submitRequest({
      baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
      intentId: "intent-pre-applied-prose",
      changes: [inlineChange(`tasks/${taskId}/task_plan.md`, planBody("Original prose."), nextBody)]
    }));

    assert.equal(result.ok, true);
    assert.equal(git(harnessRoot, "status", "--short"), "");
    assert.match(readFileSync(path.join(taskRoot, "task_plan.md"), "utf8"), /Updated before submit/u);
  });
});

test("doc sync submit fails closed before canonical mutation without a trusted principal", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskId }) => {
    const service = makeDocSyncService({ rootDir });
    const result = await service.submit(submitRequest({
      baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
      intentId: "intent-no-principal",
      changes: [inlineChange(`tasks/${taskId}/task_plan.md`, planBody("Original prose."), planBody("Rejected prose."))]
    }));

    assert.equal(result.ok, false);
    assert.equal(result._tag, "WriteRejected");
    assert.match(result.reason, /trusted authenticated person principal/u);
    assert.match(readFileSync(path.join(harnessRoot, "tasks", taskId, "task_plan.md"), "utf8"), /Original prose/u);
    assert.equal(git(harnessRoot, "status", "--short"), "");
  });
});

test("doc sync submit rejects task frontmatter markdown with a focused RPC hint", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskId }) => {
    const service = makeDocSyncService({ rootDir });
    const result = await service.submit(submitRequest({
      baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
      intentId: "intent-frontmatter",
      changes: [
        inlineChange(`tasks/${taskId}/INDEX.md`, taskIndex({ urgency: "medium" }), taskIndex({ urgency: "high" }))
      ]
    }));

    assert.equal(result.ok, false);
    assert.equal(result.code, "doc_sync_forbidden_touch");
    assert.equal(result.forbiddenTouches?.length, 1);
    assert.equal(result.forbiddenTouches?.[0]?.hunks.length, 1);
    assert.equal(result.forbiddenTouches?.[0]?.hunks[0]?.registryRowId, "task.lifecycle.transition");
    assert.equal(result.forbiddenTouches?.[0]?.hunks[0]?.requiredRpc.registryRowId, "task.lifecycle.transition");
    assert.match(readFileSync(path.join(harnessRoot, "tasks", taskId, "INDEX.md"), "utf8"), /urgency: medium/u);
  });
});

test("doc sync submit rejects decision typed records", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot }) => {
    const service = makeDocSyncService({ rootDir });
    const base = "# Decision\n\n- claim: old\n";
    const next = "# Decision\n\n- claim: new\n";
    const result = await service.submit(submitRequest({
      baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
      intentId: "intent-decision",
      changes: [inlineChange("decisions/dec_mrcda9kw.md", base, next)]
    }));

    assert.equal(result.ok, false);
    assert.equal(result.code, "doc_sync_forbidden_touch");
    assert.equal(result.forbiddenTouches?.[0]?.hunks[0]?.bearing, "decision");
  });
});

test("doc sync submit rejects disguised prose edits to task fact records", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskId }) => {
    const service = makeDocSyncService({ rootDir });
    const result = await service.submit(submitRequest({
      baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
      intentId: "intent-fact-disguised",
      changes: [
        inlineChange(`tasks/${taskId}/facts.md`, factsBody("- fact: original"), factsBody("- fact: structured mutation"))
      ]
    }));

    assert.equal(result.ok, false);
    assert.equal(result.code, "doc_sync_forbidden_touch");
    assert.match(result.unresolvedTouches?.[0]?.reason ?? "", /SEMANTIC_DIFF_AMBIGUOUS/u);
  });
});

test("doc sync allows task host-prose additions but rejects machine-written, forbidden, and non-heading module regions", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskRoot, taskId }) => {
    const progressBase = progressBody("Original log.");
    const reviewBase = reviewBody("pending");
    const moduleBase = `${JSON.stringify({ schema: "module-registry/v1", modules: [] }, null, 2)}\n`;
    writeFileSync(path.join(taskRoot, "progress.md"), progressBase, "utf8");
    writeFileSync(path.join(taskRoot, "review.md"), reviewBase, "utf8");
    writeFileSync(path.join(harnessRoot, "modules.json"), moduleBase, "utf8");
    git(harnessRoot, "add", ".");
    gitCommit(harnessRoot, "seed managed section controls");

    const validation = validateDocSyncSubmitRequest({
      rootInput: rootDir,
      request: submitRequest({
        baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
        intentId: "intent-section-controls",
        changes: [
          inlineChange(`tasks/${taskId}/task_plan.md`, planBody("Original prose."), `${planBody("Updated prose.")}## Surprise\nUndeclared.\n`),
          inlineChange(`tasks/${taskId}/progress.md`, progressBase, progressBody("Prose tamper.")),
          inlineChange(`tasks/${taskId}/review.md`, reviewBase, reviewBody("prose tamper")),
          inlineChange("modules.json", moduleBase, `${moduleBase.trimEnd()} \n`, { mediaType: "application/json" })
        ]
      })
    });

    assert.equal(validation.ok, false);
    const reasons = validation.unresolvedTouches.map((touch) => touch.reason).join("\n");
    assert.doesNotMatch(reasons, /task_plan\.md.*undeclared section/u);
    assert.match(reasons, /SEMANTIC_DIFF_REQUIRED:machine-written section requires typed command/u);
    assert.match(reasons, /SEMANTIC_DIFF_REQUIRED:forbidden section changed/u);
    assert.match(reasons, /modules\.json has no registered markdown heading region/u);
    assert.equal(readFileSync(path.join(taskRoot, "progress.md"), "utf8"), progressBase);
    assert.equal(readFileSync(path.join(taskRoot, "review.md"), "utf8"), reviewBase);
  });
});

for (const typedRecord of [
  { directory: "executions", bearing: "task-execution", registryRowId: "task.execution.record" },
  { directory: "reviews", bearing: "task-execution-review", registryRowId: "task.execution-review.record" }
] as const) {
  test(`doc sync submit rejects hosted ${typedRecord.directory} records`, async () => {
    await withHarnessFixture(async ({ rootDir, harnessRoot, taskId }) => {
      const relativePath = `tasks/${taskId}/${typedRecord.directory}/fake.md`;
      const service = makeDocSyncService({ rootDir, coordinator: attributedCoordinator(rootDir) });
      const result = await service.submit(submitRequest({
        baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
        intentId: `intent-${typedRecord.directory}`,
        changes: [inlineChange(relativePath, null, "{}\n")]
      }));

      assert.equal(result.ok, false);
      assert.equal(result.code, "doc_sync_forbidden_touch");
      assert.equal(result.forbiddenTouches?.[0]?.hunks[0]?.bearing, typedRecord.bearing);
      assert.equal(result.forbiddenTouches?.[0]?.hunks[0]?.registryRowId, typedRecord.registryRowId);
      assert.equal(existsSync(path.join(harnessRoot, relativePath)), false);
    });
  });
}

test("doc sync submit rejects stale base ledger and blob with A2 CAS shape", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskRoot, taskId }) => {
    const baseLedgerSha = git(harnessRoot, "rev-parse", "HEAD");
    const planPath = path.join(taskRoot, "task_plan.md");
    writeFileSync(planPath, planBody("Concurrent edit."), "utf8");
    git(harnessRoot, "add", "tasks");
    gitCommit(harnessRoot, "concurrent edit");

    const service = makeDocSyncService({ rootDir });
    const result = await service.submit(submitRequest({
      baseLedgerSha,
      intentId: "intent-cas",
      changes: [
        inlineChange(`tasks/${taskId}/task_plan.md`, planBody("Original prose."), planBody("Submitted edit."))
      ]
    }));

    assert.equal(result.ok, false);
    assert.equal(result._tag, "WriteRejected");
    assert.equal(result.code, "cas_watermark_mismatch");
    assert.equal(result.expectedWatermark, baseLedgerSha);
    assert.equal(result.currentWatermark, git(harnessRoot, "rev-parse", "HEAD"));
    assert.equal(result.retryable, true);
    assert.equal(result.conflicts?.[0]?.code, "base_blob_changed");
  });
});

test("doc sync post-apply checker fails hard and rolls back rpc-only mutations", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskRoot, taskId }) => {
    const service = makeDocSyncService({
      rootDir,
      afterApplyBeforePostCheck: () => {
        writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex({ urgency: "critical" }), "utf8");
      }
    });

    const result = await service.submit(submitRequest({
      baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
      intentId: "intent-post-apply",
      changes: [
        inlineChange(`tasks/${taskId}/task_plan.md`, planBody("Original prose."), planBody("Updated prose."))
      ]
    }));

    assert.equal(result.ok, false);
    assert.equal(result.code, "doc_sync_post_apply_bearing_changed");
    assert.equal(result.postApplyViolations?.[0]?.hunks[0]?.registryRowId, "task.lifecycle.transition");
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /urgency: medium/u);
    assert.match(readFileSync(path.join(taskRoot, "task_plan.md"), "utf8"), /Original prose/u);
    assert.equal(git(harnessRoot, "status", "--short"), "");
  });
});

test("doc sync submit accepts non-markdown task prose when registry bearing resolves to doc sync", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskId }) => {
    const service = makeDocSyncService({ rootDir, coordinator: attributedCoordinator(rootDir) });
    const result = await service.submit(submitRequest({
      baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
      intentId: "intent-non-md",
      changes: [
        inlineChange(`tasks/${taskId}/notes.txt`, "old notes\n", "new notes\n", { mediaType: "text/plain" })
      ]
    }));

    assert.equal(result.ok, true);
    assert.equal(result.appliedChanges[0]?.path, `tasks/${taskId}/notes.txt`);
  });
});

test("doc sync production submit ignores unrelated broken symlinks without a mutation hook", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskId }) => {
    symlinkSync("missing-target", path.join(harnessRoot, "broken-link"));
    const service = makeDocSyncService({ rootDir, coordinator: attributedCoordinator(rootDir) });

    const result = await service.submit(submitRequest({
      baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
      intentId: "intent-broken-symlink",
      changes: [
        inlineChange(`tasks/${taskId}/task_plan.md`, planBody("Original prose."), planBody("Updated prose."))
      ]
    }));

    assert.equal(result.ok, true);
    assert.equal(result.status, "accepted");
    assert.match(readFileSync(path.join(harnessRoot, "tasks", taskId, "task_plan.md"), "utf8"), /Updated prose/u);
  });
});

test("doc sync mutation hook snapshot preserves ENOTDIR for an ordinary-file authored root", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot }) => {
    rmSync(harnessRoot, { recursive: true, force: true });
    writeFileSync(harnessRoot, "not a directory", "utf8");
    const service = makeDocSyncService({ rootDir, afterApplyBeforePostCheck: () => {} });

    await assert.rejects(
      service.submit(submitRequest({
        baseLedgerSha: "no-git-head",
        intentId: "intent-file-root",
        changes: []
      })),
      (error: NodeJS.ErrnoException) => error.code === "ENOTDIR"
    );
  });
});

test("doc sync mutation hook snapshot traverses an authored root named .git", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot }) => {
    symlinkSync("missing-target", path.join(harnessRoot, ".git", "broken-link"));
    const service = makeDocSyncService({
      rootDir,
      layoutOverrides: { authoredRoot: "harness/.git" },
      afterApplyBeforePostCheck: () => {}
    });

    await assert.rejects(
      service.submit(submitRequest({
        baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
        intentId: "intent-dot-git-root",
        changes: []
      })),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );
  });
});

async function withHarnessFixture<T>(fn: (fixture: {
  readonly rootDir: string;
  readonly harnessRoot: string;
  readonly taskRoot: string;
  readonly taskId: string;
}) => T | Promise<T>, options: { readonly writeRegistry?: boolean } = {}): Promise<T> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-sync-"));
  const harnessRoot = path.join(rootDir, "harness");
  const taskId = "task_01KX3W4V1EDPHPTGWYYBQQ2J75";
  const taskRoot = path.join(harnessRoot, "tasks", taskId);
  try {
    if (options.writeRegistry !== false) {
      mkdirSync(path.join(rootDir, "tools"), { recursive: true });
      writeFileSync(path.join(rootDir, "tools", "write-road-registry.json"), registryBody, "utf8");
    }
    mkdirSync(taskRoot, { recursive: true });
    mkdirSync(path.join(harnessRoot, "decisions"), { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex({ urgency: "medium" }), "utf8");
    writeFileSync(path.join(taskRoot, "task_plan.md"), planBody("Original prose."), "utf8");
    writeFileSync(path.join(taskRoot, "facts.md"), factsBody("- fact: original"), "utf8");
    writeFileSync(path.join(taskRoot, "notes.txt"), "old notes\n", "utf8");
    writeFileSync(path.join(harnessRoot, "decisions", "dec_mrcda9kw.md"), "# Decision\n\n- claim: old\n", "utf8");
    initHarnessGit(harnessRoot);
    return await fn({ rootDir, harnessRoot, taskRoot, taskId });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function submitRequest(input: {
  readonly baseLedgerSha: string;
  readonly intentId: string;
  readonly changes: ReadonlyArray<ReturnType<typeof inlineChange>>;
}) {
  return {
    repo: { repoId: "canonical" },
    session: { sessionId: `session-${input.intentId}`, runtime: "codex" as const },
    payload: {
      baseLedgerSha: input.baseLedgerSha,
      intentId: input.intentId,
      declaredIntent: "prose-edit" as const,
      changes: input.changes
    }
  };
}

function inlineChange(pathInput: string, baseBody: string | null, newBody: string, options: { readonly mediaType?: string } = {}) {
  return {
    path: pathInput,
    baseBlobSha256: baseBody === null ? null : sha256Text(baseBody),
    newBlobSha256: sha256Text(newBody),
    mediaType: options.mediaType ?? (pathInput.endsWith(".md") ? "text/markdown" : "text/plain"),
    size: Buffer.byteLength(newBody),
    content: { kind: "inline" as const, body: newBody }
  };
}

function taskIndex(input: { readonly urgency: string }): string {
  return [
    "---",
    "schema: task-package/v2",
    "task_id: task_01KX3W4V1EDPHPTGWYYBQQ2J75",
    "status: active",
    `urgency: ${input.urgency}`,
    "vertical: software/coding",
    "preset: standard-task",
    "---",
    "# Task",
    ""
  ].join("\n");
}

function planBody(goal: string): string {
  return [
    "# Plan",
    "",
    "## Brief", "Brief.",
    "## Goal", goal,
    "## Context", "Context.",
    "## Constraints", "Constraints.",
    "## Checkpoint", "Checkpoint.",
    "## CI/Gate Authority Stop Condition", "Stop.",
    "## Implementation Plan", "Plan.",
    "## Verification", "Verify.",
    ""
  ].join("\n");
}

function factsBody(record: string): string {
  return ["# Facts", "", "## Records", "", record, ""].join("\n");
}

function progressBody(log: string): string {
  return ["# Progress", "", "## Log", "", log, "", "## Evidence", "", "None.", ""].join("\n");
}

function reviewBody(reviewer: string): string {
  return [
    "# Review", "", "## Reviewer", "", reviewer, "",
    "## D8 Stop Condition Checklist", "", "- [ ] pending", "",
    "## Findings", "", "None.", ""
  ].join("\n");
}

function factRecord(factId: string): FactRecord {
  return {
    fact_id: factId,
    statement: `Statement ${factId}`,
    source: "doc-sync test",
    observedAt: "2026-07-14T00:00:00.000Z",
    confidence: "high",
    memoryClass: "semantic",
    memoryTags: [],
    provenance: [{ runtime: "codex", sessionId: "session-w5", boundAt: "2026-07-14T00:00:00.000Z" }]
  };
}

function initHarnessGit(harnessRoot: string): void {
  git(harnessRoot, "init");
  git(harnessRoot, "config", "user.name", "Harness Test");
  git(harnessRoot, "config", "user.email", "harness@example.test");
  git(harnessRoot, "add", ".");
  gitCommit(harnessRoot, "seed");
}

function gitCommit(harnessRoot: string, message: string): void {
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", message], {
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: path.join(harnessRoot, ".empty-home"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Harness Test",
      GIT_AUTHOR_EMAIL: "harness@example.test",
      GIT_COMMITTER_NAME: "Harness Test",
      GIT_COMMITTER_EMAIL: "harness@example.test"
    }
  });
}

function git(harnessRoot: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", harnessRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: path.join(harnessRoot, ".empty-home"),
      GIT_CONFIG_GLOBAL: "/dev/null"
    }
  }).trimEnd();
}

function attributedCoordinator(rootDir: string): WriteCoordinator {
  return makeJournaledWriteCoordinator({
    rootDir,
    attribution: {
      actor: {
        principal: { kind: "person", personId: "person_test" },
        executor: { kind: "agent", id: "codex-test" }
      },
      principalSource: { kind: "local-configured", authority: "harness.yaml", authoritySha256: `sha256:${"0".repeat(64)}` },
      executorSource: "client-asserted"
    },
    commitAuthor
  });
}

function capturingAttributedCoordinator(rootDir: string, captured: Array<Record<string, unknown>>): WriteCoordinator {
  const coordinator = attributedCoordinator(rootDir);
  const journalPath = path.join(rootDir, ".harness", "write-journal", "writes.jsonl");
  return {
    ...coordinator,
    enqueue: (op) => coordinator.enqueue(op).pipe(Effect.tap(() => Effect.sync(() => {
      captured.push(...readFileSync(journalPath, "utf8").trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>));
    })))
  };
}
