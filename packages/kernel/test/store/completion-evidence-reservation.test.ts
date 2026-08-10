// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  makeJournaledWriteCoordinator,
  makeLocalVersionControlSystem,
  taskEntityId,
  type WriteError,
  type WriteOp
} from "../../src/index.ts";
import { testWriteAttribution } from "../test-attribution.ts";
import { withTempStore } from "./helpers.ts";

test("WriteCoordinator accepts completion-evidence.json through the generic document path", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    const ack = Effect.runSync(coordinator.enqueue(documentWrite()));
    assert.equal(ack.accepted, true);
  });
});

test("WriteCoordinator accepts task-tree staging with authored completion evidence", () => {
  withTempStore((rootDir) => {
    const taskRoot = path.join(rootDir, "harness/tasks/task-1");
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "closeout.md"), "# Closeout\n", "utf8");
    const local = makeLocalVersionControlSystem();
    const harnessRoot = path.join(rootDir, "harness");
    const coordinator = makeJournaledWriteCoordinator({
      attribution: testWriteAttribution(), rootDir,
      versionControlSystem: {
        ...local,
        normalizePath: (inputPath) => path.resolve(inputPath),
        topLevel: (inputPath) => path.resolve(inputPath).startsWith(harnessRoot) ? harnessRoot : rootDir,
        isIgnored: () => false,
        ignoredPaths: () => new Set(),
        workingTreeFiles: () => "?? tasks/task-1/completion-evidence.json\n"
      }
    });
    const ack = Effect.runSync(coordinator.enqueue({
      opId: "stage-raw-completion-evidence",
      entityId: taskEntityId("task-1"),
      kind: "task_tree_stage",
      payload: { scope: "task-package" }
    }));
    assert.equal(ack.accepted, true);
  });
});

test("declared entity writes do not require an absence-only completion evidence precondition", () => {
  withTempStore((rootDir) => {
    const taskRoot = path.join(rootDir, "harness/tasks/task-1");
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "completion-evidence.json"), "{\"original\":true}\n", "utf8");
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });

    const ack = Effect.runSync(coordinator.enqueue(declaredHostedWrite("completion-evidence.json")));
    assert.equal(ack.accepted, true);
  });
});

test("completion evidence absence CAS rejects replacement after reserved-path admission", () => {
  withTempStore((rootDir) => {
    const taskRoot = path.join(rootDir, "harness/tasks/task-1");
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "completion-evidence.json"), "{\"original\":true}\n", "utf8");
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });

    const failure = runWriteFailure(coordinator.enqueue(declaredHostedWrite(
      "completion-evidence.json",
      [{ taskId: "task-1", path: "completion-evidence.json", bodySha256: null }]
    )));

    assert.equal(failure._tag, "WriteRejected", JSON.stringify(failure));
    assert.match(failure.reason, /expected <missing>/u);
  });
});

test("declared primary targets may write a structurally valid code-doc document", () => {
  withTempStore((rootDir) => {
    mkdirSync(path.join(rootDir, "harness/tasks/task-1"), { recursive: true });
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });

    const ack = Effect.runSync(coordinator.enqueue(declaredHostedWrite("code-doc-anchors.json")));
    assert.equal(ack.accepted, true);
  });
});

test("code-doc documents do not need self-proof records or commit/path anchors", () => {
  withTempStore((rootDir) => {
    mkdirSync(path.join(rootDir, "harness/tasks/task-1"), { recursive: true });
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });

    const emptyAck = Effect.runSync(coordinator.enqueue({
      opId: "empty-code-doc",
      entityId: taskEntityId("task-1"),
      kind: "doc_write",
      payload: { path: "code-doc-anchors.json", body: codeDocBody([]) }
    }));
    assert.equal(emptyAck.accepted, true);

    const prOnlyAck = Effect.runSync(coordinator.enqueue({
      opId: "pr-only-code-doc",
      entityId: taskEntityId("task-1"),
      kind: "doc_write",
      payload: {
        path: "code-doc-anchors.json",
        body: codeDocBody([{
          id: "closeout",
          ledgerPath: "closeout.md",
          kind: "closeout",
          anchors: [{ kind: "pr", ref: "#1135" }]
        }])
      }
    }));
    assert.equal(prOnlyAck.accepted, true);
  });
});

test("generic code-doc writes still reject nonexistent commit anchors", () => {
  withTempStore((rootDir) => {
    mkdirSync(path.join(rootDir, "harness/tasks/task-1"), { recursive: true });
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });

    const failure = runWriteFailure(coordinator.enqueue({
      opId: "missing-code-doc-commit",
      entityId: taskEntityId("task-1"),
      kind: "doc_write",
      payload: {
        path: "code-doc-anchors.json",
        body: codeDocBody([{
          id: "closeout",
          ledgerPath: "closeout.md",
          kind: "closeout",
          anchors: [{ kind: "commit", sha: "a".repeat(40) }]
        }])
      }
    }));

    assert.equal(failure._tag, "WriteRejected", JSON.stringify(failure));
    assert.match(failure.reason, /anchor commit does not exist/u);
  });
});

test("declared entity code-doc writes still reject nonexistent commit anchors", () => {
  withTempStore((rootDir) => {
    mkdirSync(path.join(rootDir, "harness/tasks/task-1"), { recursive: true });
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });

    const failure = runWriteFailure(coordinator.enqueue(declaredHostedWrite(
      "code-doc-anchors.json",
      [],
      codeDocBody([{
        id: "closeout",
        ledgerPath: "closeout.md",
        kind: "closeout",
        anchors: [{ kind: "commit", sha: "a".repeat(40) }]
      }])
    )));

    assert.equal(failure._tag, "WriteRejected", JSON.stringify(failure));
    assert.match(failure.reason, /anchor commit does not exist/u);
  });
});

function documentWrite(): WriteOp {
  return {
    opId: "raw-completion-evidence",
    entityId: taskEntityId("task-1"),
    kind: "doc_write",
    payload: { path: "completion-evidence.json", body: "{}" }
  };
}

function declaredHostedWrite(
  documentPath: string,
  preconditions: ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly bodySha256: null }> = [],
  body?: string
): WriteOp {
  return {
    opId: `declared-${documentPath}`,
    entityId: "entity/task/task-1" as WriteOp["entityId"],
    kind: "doc_write",
    payload: {
      entityDocument: {
        declaration: {
          kind: "task",
          storageForm: "hosted-entity",
          rootResolver: {
            pathTemplate: `tasks/{taskId}/${documentPath}`,
            identity: ["taskId"],
            host: { entityKind: "task", pathTemplate: "tasks/{taskId}", identity: ["taskId"] }
          }
        },
        identity: { taskId: "task-1" },
        body: body ?? (documentPath === "code-doc-anchors.json" ? validCodeDocBody() : "{\"replacement\":true}\n")
      },
      preconditions
    }
  };
}

function validCodeDocBody(): string {
  return codeDocBody([{
    id: "closeout",
    ledgerPath: "closeout.md",
    kind: "closeout",
    anchors: [{ kind: "pr", ref: "#1135" }]
  }]);
}

function codeDocBody(records: ReadonlyArray<Record<string, unknown>>): string {
  return `${JSON.stringify({
    schema: "code-doc-reconciliation/v1",
    taskId: "task-1",
    records
  })}\n`;
}

function runWriteFailure<A>(effect: Effect.Effect<A, WriteError>): WriteError {
  const result = Effect.runSync(Effect.either(effect));
  assert.equal(result._tag, "Left");
  return result.left;
}
