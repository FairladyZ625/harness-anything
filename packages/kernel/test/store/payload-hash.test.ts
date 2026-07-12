// harness-test-tier: integration
import { testWriteAttribution } from "../test-attribution.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import {
  decisionEntityId,
  moduleEntityId,
  taskEntityId,
  type DecisionPackage,
  type FactRecord
} from "../../src/domain/index.ts";
import type { DocumentWrite } from "../../src/ports/artifact-store-writer.ts";
import type { WriteOp } from "../../src/ports/write-coordinator.ts";
import { writeContentAddressedBlob } from "../../src/store/content-addressed-blob-store.ts";
import { stablePayloadHash } from "../../src/integrity/stable-hash.ts";
import { createTaskPackagePath, normalizeRelativeDocumentPath, resolveHarnessLayout, taskPackagePath } from "../../src/layout/index.ts";
import { applyWriteOp, documentWritesForWriteOp, writeOpTouchedPaths } from "../../src/store/write-journal-operations.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/index.ts";
import { docWrite, withTempStore } from "./helpers.ts";

test("payload hashes are stable across object key order", () => {
  assert.equal(
    stablePayloadHash({ body: "x", path: "a.md" }),
    stablePayloadHash({ path: "a.md", body: "x" })
  );
});

test("journal stores payload hash for audit", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    Effect.runSync(coordinator.enqueue(docWrite("op-1", "task-1", "a.md", "x")));

    const journal = readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8");
    assert.match(journal, /"payloadHash":"[0-9a-f]{64}"/);
  });
});

test("recovery rejects a tampered payloadRef before applying writes", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    Effect.runSync(coordinator.enqueue(docWrite("op-1", "task-1", "a.md", "trusted")));

    const journalRecord = JSON.parse(readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8")) as {
      readonly payloadRef: {
        readonly path: string;
      };
    };
    writeFileSync(path.join(rootDir, journalRecord.payloadRef.path), JSON.stringify({
      path: "a.md",
      body: "tampered"
    }), "utf8");

    const recoveredCoordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    assert.throws(
      () => Effect.runSync(recoveredCoordinator.recover),
      /payloadRef sha mismatch|payload hash mismatch/
    );
  });
});

test("write-journal operation declarations reconcile with apply filesystem effects", () => {
  const caseNames = allReconciliationCases(process.cwd()).map((fixture) => fixture.name);
  for (const caseName of caseNames) {
    test(caseName, () => {
      withTempStore((rootDir) => {
        const fixture = allReconciliationCases(rootDir).find((candidate) => candidate.name === caseName);
        assert.ok(fixture !== undefined, `${caseName}: fixture not found`);

        fixture.setup?.(rootDir);

        const before = snapshotFiles(rootDir);
        const touched = writeOpTouchedPaths(rootDir, fixture.op).map((entry) => path.resolve(entry));
        const derivedWrites = fixture.expectedDocumentWrites.map((write) => canonicalizeDocumentWrite(write));

        assert.deepEqual(
          sortDocumentWrites(derivedWrites),
          sortDocumentWrites(fixture.expectedDocumentWrites.map((write) => canonicalizeDocumentWrite(write))
          )
        );

        applyWriteOp(rootDir, fixture.op);
        const after = snapshotFiles(rootDir);
        const changedPaths = changedFilePaths(before, after);

        for (const changedPath of changedPaths) {
          assert.equal(
            isCoveredByTouchedPaths(changedPath, touched),
            true,
            `${fixture.name}: changed path ${changedPath} not covered by touchedPaths`
          );
        }

        for (const write of derivedWrites) {
          const target = documentWriteTarget(rootDir, write);
          assert.equal(
            isCoveredByTouchedPaths(target, touched),
            true,
            `${fixture.name}: document write ${target} not covered by touchedPaths`
          );
        }
      });
    });
  }
});

test("machine_artifact_write bodyRef documentWrites is cwd independent", () => {
  withTempStore((rootDir) => {
    const layout = resolveHarnessLayout(rootDir);
    const bodyRef = writeContentAddressedBlob(rootDir, "machine artifact body", "text/plain");
    const op: WriteOp = {
      opId: "recon-machine-artifact-bodyref", 
      entityId: taskEntityId("task_machine_artifact_bodyref"),
      kind: "machine_artifact_write",
      payload: {
        boundary: "docmap-derived",
        path: path.relative(layout.rootDir, path.join(layout.authoredRoot, "docmap.json")),
        bodyRef
      }
    };

    const outOfHarness = path.join(rootDir, ".tmp", "outside-layout");
    mkdirSync(outOfHarness, { recursive: true });
    const previousCwd = process.cwd();
    try {
      process.chdir(outOfHarness);
      assert.doesNotThrow(() => {
        const writes = documentWritesForWriteOp(op);
        assert.deepEqual(writes, []);
      });
    } finally {
      process.chdir(previousCwd);
    }
  });
});

type ReconciliationCase = {
  readonly name: string;
  readonly op: WriteOp;
  readonly expectedDocumentWrites: ReadonlyArray<DocumentWrite>;
  readonly setup?: (rootDir: string) => void;
};

function allReconciliationCases(rootDir: string): ReconciliationCase[] {
  const layout = resolveHarnessLayout(rootDir);
  const dec = decisionPackage({ decision_id: "dec_REC_001" });
  return [
    {
      name: "package_create",
      op: {
        opId: "recon-package-create",
        entityId: taskEntityId("task_pkg_create"),
        kind: "package_create",
        payload: {
          writes: [
            {
              taskId: "task_pkg_create",
              path: "INDEX.md",
              body: "create index",
              packageSlug: "created"
            }
          ]
        }
      },
      expectedDocumentWrites: [
        { taskId: "task_pkg_create", path: "INDEX.md", body: "create index", packageSlug: "created" }
      ]
    },
    {
      name: "package_supersede",
      op: {
        opId: "recon-package-supersede",
        entityId: taskEntityId("task_pkg_supersede"),
        kind: "package_supersede",
        payload: {
          writes: [
            {
              taskId: "task_pkg_supersede",
              path: "INDEX.md",
              body: "supersede index",
              packageSlug: "superseded"
            }
          ]
        }
      },
      expectedDocumentWrites: [
        { taskId: "task_pkg_supersede", path: "INDEX.md", body: "supersede index", packageSlug: "superseded" }
      ]
    },
    {
      name: "package_archive",
      op: {
        opId: "recon-package-archive",
        entityId: taskEntityId("task_pkg_archive"),
        kind: "package_archive",
        payload: {
          taskId: "task_pkg_archive",
          path: "INDEX.md",
          body: "archive content",
          packageSlug: "archived"
        } as { taskId: string; path: string; body: string; packageSlug?: string; }
      },
      expectedDocumentWrites: [
        { taskId: "task_pkg_archive", path: "INDEX.md", body: "archive content", packageSlug: "archived" }
      ]
    },
    {
      name: "package_tombstone",
      op: {
        opId: "recon-package-tombstone",
        entityId: taskEntityId("task_pkg_tombstone"),
        kind: "package_tombstone",
        payload: {
          taskId: "task_pkg_tombstone",
          path: "INDEX.md",
          body: "tombstone content",
          packageSlug: "tombstoned"
        } as { taskId: string; path: string; body: string; packageSlug?: string; }
      },
      expectedDocumentWrites: [
        { taskId: "task_pkg_tombstone", path: "INDEX.md", body: "tombstone content", packageSlug: "tombstoned" }
      ]
    },
    {
      name: "package_reopen",
      op: {
        opId: "recon-package-reopen",
        entityId: taskEntityId("task_pkg_reopen"),
        kind: "package_reopen",
        payload: {
          taskId: "task_pkg_reopen",
          path: "INDEX.md",
          body: "reopen content",
          packageSlug: "reopened"
        } as { taskId: string; path: string; body: string; packageSlug?: string; }
      },
      expectedDocumentWrites: [
        { taskId: "task_pkg_reopen", path: "INDEX.md", body: "reopen content", packageSlug: "reopened" }
      ]
    },
    {
      name: "package_delete_hard",
      op: {
        opId: "recon-package-delete-hard",
        entityId: taskEntityId("task_pkg_delete"),
        kind: "package_delete_hard",
        payload: { reason: "reconciliation fixture" }
      },
      expectedDocumentWrites: [],
      setup: (rootDir) => {
        writeTaskPackageIndex(rootDir, "task_pkg_delete", {
          status: "planned",
          packageDisposition: "active"
        });
      }
    },
    {
      name: "transition_local",
      op: {
        opId: "recon-transition-local",
        entityId: taskEntityId("task_transition"),
        kind: "transition_local",
        payload: {
          to: "active",
          path: "INDEX.md",
          body: "status: active"
        }
      },
      expectedDocumentWrites: [{ taskId: "task_transition", path: "INDEX.md", body: "status: active" }]
    },
    {
      name: "progress_append",
      op: {
        opId: "recon-progress-append",
        entityId: taskEntityId("task_progress"),
        kind: "progress_append",
        payload: {
          path: "progress.md",
          append: "progress line\n"
        }
      },
      expectedDocumentWrites: [{ taskId: "task_progress", path: "progress.md", body: "" }]
    },
    {
      name: "progress_append_snapshot",
      op: {
        opId: "recon-progress-append-snapshot",
        entityId: taskEntityId("task_progress_snapshot"),
        kind: "progress_append",
        payload: {
          path: "progress.md",
          body: "legacy snapshot\n"
        }
      },
      expectedDocumentWrites: [{ taskId: "task_progress_snapshot", path: "progress.md", body: "legacy snapshot\n" }]
    },
    {
      name: "doc_write",
      op: {
        opId: "recon-doc-write",
        entityId: taskEntityId("task_doc"),
        kind: "doc_write",
        payload: {
          path: "notes.md",
          body: "hello doc"
        }
      },
      expectedDocumentWrites: [{ taskId: "task_doc", path: "notes.md", body: "hello doc" }]
    },
    {
      name: "fact_invalidate",
      op: {
        opId: "recon-fact-invalidate",
        entityId: taskEntityId("task_fact"),
        kind: "fact_invalidate",
        payload: {
          path: "facts.md",
          appendRecord: {
            kind: "fact-record/v1",
            record: fact("F-123456", "fact for fixture")
          }
        }
      },
      expectedDocumentWrites: [{ taskId: "task_fact", path: "facts.md", body: "" }]
    },
    {
      name: "doc_stage",
      op: {
        opId: "recon-doc-stage",
        entityId: taskEntityId("task_stage"),
        kind: "doc_stage",
        payload: {
          path: "progress.md",
          packageSlug: "staged"
        }
      },
      expectedDocumentWrites: []
    },
    {
      name: "task_tree_stage",
      op: {
        opId: "recon-task-tree-stage",
        entityId: taskEntityId("task_tree_stage"),
        kind: "task_tree_stage"
      },
      expectedDocumentWrites: []
    },
    {
      name: "decision_propose",
      op: {
        opId: "recon-decision-propose",
        entityId: decisionEntityId("dec_REC_001"),
        kind: "decision_propose",
        payload: {
          decision: dec,
          body: "# propose",
          taskWrites: [{ taskId: "task_decision", path: "facts.md", body: "decision task write", packageSlug: "fact" }]
        }
      },
      expectedDocumentWrites: [
        { taskId: "task_decision", path: "facts.md", body: "decision task write", packageSlug: "fact" }
      ]
    },
    {
      name: "decision_accept",
      op: {
        opId: "recon-decision-accept",
        entityId: decisionEntityId("dec_REC_001"),
        kind: "decision_accept",
        payload: {
          decision: { ...dec, state: "active" },
          title: "Accepted decision",
          body: "# accept"
        }
      },
      expectedDocumentWrites: []
    },
    {
      name: "decision_reject",
      op: {
        opId: "recon-decision-reject",
        entityId: decisionEntityId("dec_REC_001"),
        kind: "decision_reject",
        payload: {
          decision: { ...dec, state: "rejected" },
          title: "Rejected decision",
          body: "# reject"
        }
      },
      expectedDocumentWrites: []
    },
    {
      name: "decision_defer",
      op: {
        opId: "recon-decision-defer",
        entityId: decisionEntityId("dec_REC_001"),
        kind: "decision_defer",
        payload: {
          decision: { ...dec, state: "deferred" },
          title: "Deferred decision",
          body: "# defer"
        }
      },
      expectedDocumentWrites: []
    },
    {
      name: "decision_supersede",
      op: {
        opId: "recon-decision-supersede",
        entityId: decisionEntityId("dec_REC_001"),
        kind: "decision_supersede",
        payload: {
          decision: { ...dec, state: "retired" },
          title: "Superseded decision",
          body: "# supersede"
        }
      },
      expectedDocumentWrites: []
    },
    {
      name: "decision_amend",
      op: {
        opId: "recon-decision-amend",
        entityId: decisionEntityId("dec_REC_001"),
        kind: "decision_amend",
        payload: {
          decision: dec,
          title: "Amended decision",
          body: "# amend"
        }
      },
      expectedDocumentWrites: []
    },
    {
      name: "decision_relate",
      op: {
        opId: "recon-decision-relate",
        entityId: decisionEntityId("dec_REC_001"),
        kind: "decision_relate",
        payload: {
          decision: dec,
          body: "# relate"
        }
      },
      expectedDocumentWrites: []
    },
    {
      name: "decision_retire",
      op: {
        opId: "recon-decision-retire",
        entityId: decisionEntityId("dec_REC_001"),
        kind: "decision_retire",
        payload: {
          decision: { ...dec, state: "retired" },
          body: "# retire"
        }
      },
      expectedDocumentWrites: []
    },
    {
      name: "relation_retire",
      op: {
        opId: "recon-relation-retire",
        entityId: decisionEntityId("dec_REC_001"),
        kind: "relation_retire",
        payload: {
          decision: dec,
          body: "# relation-retire"
        }
      },
      expectedDocumentWrites: []
    },
    {
      name: "relation_replace",
      op: {
        opId: "recon-relation-replace",
        entityId: decisionEntityId("dec_REC_001"),
        kind: "relation_replace",
        payload: {
          decision: dec,
          body: "# relation-replace"
        }
      },
      expectedDocumentWrites: []
    },
    {
      name: "module_registry_write",
      op: {
        opId: "recon-module-registry",
        entityId: moduleEntityId("m-recon"),
        kind: "module_registry_write",
        payload: {
          registry: { modules: ["recon"] }
        }
      },
      expectedDocumentWrites: []
    },
    {
      name: "module_scaffold_write",
      op: {
        opId: "recon-module-scaffold",
        entityId: moduleEntityId("m-recon"),
        kind: "module_scaffold_write",
        payload: {
          writes: [{ path: "README.md", body: "# module scaffold" }]
        }
      },
      expectedDocumentWrites: []
    },
    {
      name: "machine_artifact_write",
      op: {
        opId: "recon-machine-artifact-write",
        entityId: taskEntityId("task_artifact"),
        kind: "machine_artifact_write",
        payload: {
          boundary: "docmap-derived",
          path: path.relative(layout.rootDir, path.join(layout.authoredRoot, "docmap.json")),
          body: "{}"
        }
      },
      expectedDocumentWrites: []
    },
    {
      name: "machine_artifact_append_jsonl",
      op: {
        opId: "recon-machine-artifact-append-jsonl",
        entityId: taskEntityId("task_artifact"),
        kind: "machine_artifact_append_jsonl",
        payload: {
          boundary: "runtime-event-ledger",
          path: path.relative(layout.rootDir, path.join(layout.localRoot, "generated", "runtime-events", "session-events.jsonl")),
          value: {
            event: "recon",
            at: "2026-07-10T00:00:00Z"
          }
        }
      },
      expectedDocumentWrites: []
    }
  ];
}

function isCoveredByTouchedPaths(candidate: string, touchedPaths: ReadonlyArray<string>): boolean {
  return touchedPaths.some((touched) => candidate === touched || candidate.startsWith(`${touched}${path.sep}`));
}

function snapshotFiles(rootDir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.name === ".git" || entry.name === ".harness") continue;
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile()) {
        files.set(path.resolve(child), readFileSync(child, "utf8"));
      }
    }
  };

  walk(rootDir);
  return files;
}

function changedFilePaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const filePath of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(filePath) !== after.get(filePath)) changed.add(filePath);
  }
  return [...changed].sort();
}

function sortDocumentWrites(writes: ReadonlyArray<DocumentWrite>): string[] {
  return [...writes]
    .map((entry) => `${entry.taskId}|${entry.packageSlug ?? ""}|${entry.path}|${entry.body}`)
    .sort();
}

function canonicalizeDocumentWrite(write: DocumentWrite): DocumentWrite {
  return {
    taskId: write.taskId,
    path: normalizeRelativeDocumentPath(write.path),
    body: write.body,
    ...(write.packageSlug ? { packageSlug: write.packageSlug } : {})
  };
}

function documentWriteTarget(rootDir: string, write: DocumentWrite): string {
  const packagePath = existsSync(taskPackagePath(rootDir, write.taskId))
    ? taskPackagePath(rootDir, write.taskId)
    : createTaskPackagePath(rootDir, write.taskId, write.packageSlug);
  return path.resolve(path.join(packagePath, normalizeRelativeDocumentPath(write.path)));
}

function writeTaskPackageIndex(rootDir: string, taskId: string, options: { readonly status: string; readonly packageDisposition: string; }): void {
  const packagePath = taskPackagePath(rootDir, taskId);
  mkdirSync(packagePath, { recursive: true });
  const indexPath = path.join(packagePath, "INDEX.md");
  writeFileSync(indexPath, [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "title: reconciliation package",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${options.status}`,
    "  ref: ",
    "  titleSnapshot: reconciliation",
    "  url: ",
    "  bindingCreatedAt: 2026-07-10T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    `packageDisposition: ${options.packageDisposition}`,
    "vertical: default",
    "preset: default",
    "---",
    ""
  ].join("\n"));
}

function fact(factId: string, statement: string): FactRecord {
  return {
    fact_id: factId,
    statement,
    observedAt: "2026-07-10T00:00:00.000Z",
    confidence: "high",
    memoryClass: "episodic",
    memoryTags: [],
    source: "test",
    provenance: [{
      runtime: "human",
      sessionId: "recon",
      boundAt: "2026-07-10T00:00:00.000Z"
    }]
  };
}

function decisionPackage(overrides: Partial<DecisionPackage> = {}): DecisionPackage {
  return {
    schema: "decision-package/v1",
    decision_id: "dec_REC_001",
    title: "Reconciliation decision",
    state: "proposed",
    riskTier: "medium",
    urgency: "medium",
    vertical: "software/coding",
    preset: "architecture-decision",
    applies_to: {
      modules: ["kernel"],
      productLines: []
    },
    proposedBy: { kind: "agent", id: "recon" },
    proposedAt: "2026-07-10T00:00:00Z",
    arbiter: { kind: "human", id: "ZeyuLi" },
    provenance: [{
      runtime: "human",
      sessionId: "recon",
      boundAt: "2026-07-10T00:00:00Z"
    }],
    question: "Would this reconciliation fixture be accepted?",
    chosen: [{ id: "CH1", text: "write through declaration." }],
    rejected: [{ id: "RJ1", text: "manual path.", why_not: "Not needed for fixture" }],
    claims: [{ id: "C1", text: "Consistency should stay stable." }],
    relations: [],
    ...overrides
  };
}
