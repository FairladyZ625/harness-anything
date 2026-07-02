import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { makeJournaledWriteCoordinator } from "../../../kernel/src/store/index.ts";
import {
  makeMulticaAdoptionService,
  makeMulticaLifecycleEngine,
  stableMulticaBindingFingerprint,
  type MulticaClient,
  type MulticaRawIssue
} from "../src/index.ts";

test("Multica LifecycleEngine exposes readonly snapshot capabilities only", () => {
  const engine = makeMulticaLifecycleEngine({ client: fakeClient([issue("FAI-1", "Todo")]) });
  const capabilities = Effect.runSync(engine.capabilities);

  assert.deepEqual(capabilities, {
    snapshots: true,
    listTasks: true,
    publishNote: false
  });
  assert.equal("publishNote" in engine, false);
  assert.equal("transition" in engine, false);
  assert.equal("assign" in engine, false);
  assert.equal("cancel" in engine, false);
});

test("Multica snapshot maps known and unmapped statuses without fabricating local state", () => {
  const engine = makeMulticaLifecycleEngine({
    client: fakeClient([
      issue("FAI-1", "In Review"),
      issue("FAI-2", "Vendor Specific")
    ]),
    clock: fixedClock
  });

  const inReview = Effect.runSync(engine.snapshot({ engine: "multica", ref: "FAI-1" }));
  const unmapped = Effect.runSync(engine.snapshot({ engine: "multica", ref: "FAI-2" }));

  assert.equal(inReview.canonicalStatus, "in_review");
  assert.equal(inReview.rawStatus, "In Review");
  assert.equal(inReview.source, "external-engine");
  assert.equal(unmapped.canonicalStatus, "unknown");
  assert.equal(unmapped.rawStatus, "Vendor Specific");
  assert.equal(unmapped.staleReason, "status_unmapped");
});

test("Multica unreachable returns stale cache when available and unavailable-no-cache otherwise", () => {
  let reachable = true;
  const client: MulticaClient = {
    fetchIssue: (ref) => reachable
      ? Effect.succeed(issue(ref, "Active"))
      : Effect.fail({ _tag: "EngineUnreachable", engine: "multica" })
  };
  const engine = makeMulticaLifecycleEngine({
    client,
    clock: fixedClock,
    staleTtlMs: 60_000
  });

  Effect.runSync(engine.snapshot({ engine: "multica", ref: "FAI-1" }));
  reachable = false;

  const stale = Effect.runSync(engine.snapshot({ engine: "multica", ref: "FAI-1" }));
  const missing = Effect.runSync(engine.snapshot({ engine: "multica", ref: "FAI-2" }));

  assert.equal(stale.canonicalStatus, "active");
  assert.equal(stale.freshness, "stale-but-usable");
  assert.equal(stale.source, "snapshot-cache");
  assert.equal(missing.canonicalStatus, "unknown");
  assert.equal(missing.freshness, "unavailable-no-cache");
});

test("Multica adopt writes only local binding and does not write external status into frontmatter", () => {
  withTempRoot((rootDir) => {
    const service = makeMulticaAdoptionService({
      rootDir,
      client: fakeClient([issue("FAI-1", "Done")]),
      coordinator: makeJournaledWriteCoordinator({ rootDir }),
      clock: fixedClock
    });

    const result = Effect.runSync(service.adopt({ taskId: "task-1", ref: "FAI-1" }));
    const index = readFileSync(path.join(rootDir, "harness/planning/tasks/task-1/INDEX.md"), "utf8");

    assert.deepEqual(result, { taskId: "task-1", engine: "multica", ref: "FAI-1" });
    assert.match(index, /engine: multica/);
    assert.match(index, /ref: FAI-1/);
    assert.match(index, /titleSnapshot: Multica FAI-1/);
    assert.equal(/^  status:/mu.test(index), false);
    assert.equal(index.includes("Done"), false);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /"projectionHash":"sha256:/);
  });
});

test("Multica adopt rejects duplicate external bindings and task id conflicts", () => {
  withTempRoot((rootDir) => {
    const service = makeMulticaAdoptionService({
      rootDir,
      client: fakeClient([issue("FAI-1", "Active")]),
      coordinator: makeJournaledWriteCoordinator({ rootDir }),
      clock: fixedClock
    });

    Effect.runSync(service.adopt({ taskId: "task-1", ref: "FAI-1" }));

    const duplicateRef = Effect.runSyncExit(service.adopt({ taskId: "task-2", ref: "FAI-1" }));
    const duplicateTask = Effect.runSyncExit(service.adopt({ taskId: "task-1", ref: "FAI-2" }));

    assert.equal(duplicateRef._tag, "Failure");
    assert.match(String(duplicateRef.cause), /DuplicateExternalBinding/);
    assert.equal(duplicateTask._tag, "Failure");
    assert.match(String(duplicateTask.cause), /TaskAlreadyExists/);
  });
});

test("Multica adopt uses explicit authored root for reads, claims, and writes", () => {
  withTempRoot((rootDir) => {
    const layoutOverrides = { authoredRoot: ".custom-harness" };
    const service = makeMulticaAdoptionService({
      rootDir,
      layoutOverrides,
      client: fakeClient([issue("FAI-1", "Active")]),
      coordinator: makeJournaledWriteCoordinator({ rootDir, layoutOverrides }),
      clock: fixedClock
    });

    Effect.runSync(service.adopt({ taskId: "task-1", ref: "FAI-1" }));
    const duplicateRef = Effect.runSyncExit(service.adopt({ taskId: "task-2", ref: "FAI-1" }));
    const duplicateTask = Effect.runSyncExit(service.adopt({ taskId: "task-1", ref: "FAI-2" }));

    assert.equal(existsSync(path.join(rootDir, ".custom-harness/planning/tasks/task-1/INDEX.md")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/planning/tasks/task-1/INDEX.md")), false);
    assert.equal(duplicateRef._tag, "Failure");
    assert.match(String(duplicateRef.cause), /DuplicateExternalBinding/);
    assert.equal(duplicateTask._tag, "Failure");
    assert.match(String(duplicateTask.cause), /TaskAlreadyExists/);
  });
});

test("Multica adopt claim rejects duplicate refs before authored scan can see them", () => {
  withTempRoot((rootDir) => {
    mkdirSync(path.join(rootDir, ".harness/adopt-claims", "binding", "d8469170d66bc64c333119e46da4697d62ed8e4cf611864b128b5ef5df48301c"), {
      recursive: true
    });
    const service = makeMulticaAdoptionService({
      rootDir,
      client: fakeClient([issue("FAI-1", "Active")]),
      coordinator: makeJournaledWriteCoordinator({ rootDir }),
      clock: fixedClock
    });

    const result = Effect.runSyncExit(service.adopt({ taskId: "task-1", ref: "FAI-1" }));

    assert.equal(result._tag, "Failure");
    assert.match(String(result.cause), /DuplicateAdoptClaim/);
    assert.equal(existsSync(path.join(rootDir, "harness/planning/tasks/task-1/INDEX.md")), false);
  });
});

test("Multica binding fingerprint is order-insensitive and tied to immutable identity fields", () => {
  const left = stableMulticaBindingFingerprint({
    engine: "multica",
    ref: "FAI-1",
    bindingCreatedAt: "2026-06-12T00:00:00.000Z"
  });
  const right = stableMulticaBindingFingerprint({
    ref: "FAI-1",
    bindingCreatedAt: "2026-06-12T00:00:00.000Z",
    engine: "multica"
  });
  const changedRef = stableMulticaBindingFingerprint({
    engine: "multica",
    ref: "FAI-2",
    bindingCreatedAt: "2026-06-12T00:00:00.000Z"
  });

  assert.equal(left, right);
  assert.notEqual(left, changedRef);
});

test("Multica adopt refuses stale snapshots instead of binding uncertain external state", () => {
  withTempRoot((rootDir) => {
    const service = makeMulticaAdoptionService({
      rootDir,
      client: {
        fetchIssue: () => Effect.fail({ _tag: "EngineUnreachable", engine: "multica" })
      },
      coordinator: makeJournaledWriteCoordinator({ rootDir }),
      clock: fixedClock
    });

    const result = Effect.runSyncExit(service.adopt({ taskId: "task-1", ref: "FAI-1" }));

    assert.equal(result._tag, "Failure");
    assert.match(String(result.cause), /StaleSnapshotRefused/);
  });
});

function fakeClient(issues: ReadonlyArray<MulticaRawIssue>): MulticaClient {
  return {
    fetchIssue: (ref) => {
      const found = issues.find((candidate) => candidate.ref === ref);
      return found ? Effect.succeed(found) : Effect.fail({ _tag: "RefNotFound", ref });
    },
    listIssues: () => Effect.succeed(issues)
  };
}

function issue(ref: string, status: string): MulticaRawIssue {
  return {
    ref,
    title: `Multica ${ref}`,
    status,
    url: `https://example.invalid/${ref}`,
    updatedAt: "2026-06-12T00:00:00.000Z"
  };
}

function fixedClock(): Date {
  return new Date("2026-06-12T00:00:00.000Z");
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-multica-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
