// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assessTransitionDocument, transitionDocumentContract, type TaskProjection } from "@harness-anything/kernel";
import {
  assertTaskTransitionDocumentReady,
  transitionDocumentReadinessContract,
} from "../src/transition-document-access.ts";

const planHeadings = [
  "Brief",
  "Goal",
  "Cheaper Alternatives",
  "Context",
  "Required Reading",
  "Execution Surface",
  "Constraints",
  "Deliverable Contract",
  "Evidence Protocol",
  "Verification",
] as const;

test("transition-document readiness reports scaffold and empty sections as structured entries", () => {
  const template = readFileSync(
      new URL("../../preset/assets/software-coding/templates/task.plan.v2/en-US.md", import.meta.url),
      "utf8",
    ),
    partial = realizedPlan().replace(
      "## Brief\n\nImplemented Brief.",
      "## Brief\n\nOne-line statement of the task objective and scope.",
    ),
    empty = realizedPlan().replace("## Verification\n\nImplemented Verification.", "## Verification\n\n"),
    cases = [
      {
        name: "all-template plan",
        body: template,
        expectedFirst: {
          section: "Brief",
          reason: "scaffold",
          retainedScaffold: "One-line statement of the task objective and scope.",
        },
        expectedEntries: planHeadings.length,
      },
      {
        name: "partially realized plan",
        body: partial,
        expectedFirst: {
          section: "Brief",
          reason: "scaffold",
          retainedScaffold: "One-line statement of the task objective and scope.",
        },
        expectedEntries: 1,
      },
      {
        name: "empty section",
        body: empty,
        expectedFirst: { section: "Verification", reason: "empty" },
        expectedEntries: 1,
      },
      {
        name: "fully realized plan",
        body: realizedPlan(),
        expectedFirst: undefined,
        expectedEntries: 0,
      },
    ] as const;

  const contract = transitionDocumentContract(
    template,
    planHeadings.map((section) => `## ${section}`),
  );
  for (const fixture of cases) {
    const missing = assessTransitionDocument("task.plan", fixture.body, contract).missingSections;
    assert.equal(missing.length, fixture.expectedEntries, fixture.name);
    assert.deepEqual(missing[0], fixture.expectedFirst, fixture.name);
  }
});

test("readiness contract resolves from the descriptor-embedded map, then the bundled catalog", () => {
  const template = readFileSync(
      new URL("../../preset/assets/software-coding/templates/task.plan.v2/en-US.md", import.meta.url),
      "utf8",
    ),
    templateRef = "template://planning/task-plan@2",
    embedded = { Brief: ["One-line statement of the task objective and scope."], Verification: [] },
    // A descriptor whose readiness map was frozen at materialization never consults the catalog:
    // the embedded contract wins even when the templateRef cannot resolve.
    fromEmbedded = transitionDocumentReadinessContract({
      contract: { locale: "en-US" },
      descriptor: {
        slot: "task.plan",
        path: "task_plan.md",
        templateRef: "template://missing/none@0",
        readiness: embedded,
      },
    });
  assert.deepEqual(fromEmbedded, {
    requiredSections: ["Brief", "Verification"],
    scaffoldBySection: embedded,
  });
  // The frozen map is authoritative and resolving it opens no file: even a templateRef the bundled
  // catalog can resolve yields only the frozen keys, so task start adds no template read.
  const embeddedWithResolvableCatalog = transitionDocumentReadinessContract({
    contract: { locale: "en-US" },
    descriptor: { slot: "task.plan", path: "task_plan.md", templateRef, readiness: embedded },
  });
  assert.deepEqual(embeddedWithResolvableCatalog, {
    requiredSections: ["Brief", "Verification"],
    scaffoldBySection: embedded,
  });
  // A malformed embedded map is not a contract; resolution falls back to the bundled catalog the
  // descriptor's templateRef names, as for packages materialized before descriptors carried it.
  // The fallback uses the catalog's baseline anchors, so a conditional section added later cannot
  // backfill an already-published plan.
  const fromCatalog = transitionDocumentReadinessContract({
    contract: { locale: "en-US" },
    descriptor: { slot: "task.plan", path: "task_plan.md", templateRef, readiness: { Brief: "not-an-array" } },
  });
  assert.equal(transitionDocumentContract(template).requiredSections.includes("Recurrence Gate"), true);
  assert.deepEqual(
    fromCatalog,
    transitionDocumentContract(
      template,
      planHeadings.map((section) => `## ${section}`),
    ),
  );
  assert.equal(fromCatalog?.requiredSections.includes("Recurrence Gate"), false);
  assert.equal(
    transitionDocumentReadinessContract({
      contract: { locale: "en-US" },
      descriptor: { slot: "task.plan", path: "task_plan.md", templateRef: "template://missing/none@0" },
    }),
    null,
  );
});

test("a descriptor frozen on the 13-section template still reads that catalog version", () => {
  const legacyTemplate = readFileSync(
      new URL("../../preset/assets/software-coding/templates/task.plan/en-US.md", import.meta.url),
      "utf8",
    ),
    contract = transitionDocumentReadinessContract({
      contract: { locale: "en-US" },
      descriptor: { slot: "task.plan", path: "task_plan.md", templateRef: "template://planning/task-plan@1" },
    });
  assert.deepEqual(contract, transitionDocumentContract(legacyTemplate));
  assert.deepEqual(
    assessTransitionDocument("task.plan", realizedPlan(), contract!).missingSections.map(({ section }) => section),
    ["Entry Conditions", "Dependencies", "Checkpoint", "Implementation Plan"],
  );
});

test("a contract citing the retired milestone plan template reads the work plan scaffold it was renamed to", () => {
  const workPlan = readFileSync(
      new URL("../../preset/assets/software-coding/templates/task.work.plan/zh-CN.md", import.meta.url),
      "utf8",
    ),
    // dec_5F7E74F1: task contracts are immutable, so historical create-milestone packages keep this ref.
    contract = transitionDocumentReadinessContract({
      contract: { locale: "zh-CN" },
      descriptor: { slot: "task.plan", path: "task_plan.md", templateRef: "template://planning/milestone-task-plan@1" },
    });
  assert.deepEqual(contract, transitionDocumentContract(workPlan));
});

function realizedPlan(): string {
  return `# Plan\n\n${planHeadings.map((heading) => `## ${heading}\n\nImplemented ${heading}.`).join("\n\n")}\n`;
}

/** One task package whose plan contract and body are otherwise ready. */
function admissionProjection(
  task: Readonly<Record<string, unknown>>,
  planBody = realizedPlan(),
  requiredAnchors?: readonly string[],
): TaskProjection {
  const template = readFileSync(
      new URL("../../preset/assets/software-coding/templates/task.plan.v2/en-US.md", import.meta.url),
      "utf8",
    ),
    contractBody = JSON.stringify({
      documents: [
        {
          slot: "task.plan",
          path: "task_plan.md",
          readiness: transitionDocumentContract(
            template,
            requiredAnchors ?? planHeadings.map((section) => `## ${section}`),
          ).scaffoldBySection,
        },
      ],
    });
  return {
    read: () => ({
      status: "ready",
      watermark: 1,
      sourceRevision: 1,
      snapshot: { task },
      packagePath: "tasks/task-1",
    }),
    readDocument: (target: string) => ({
      status: "ready",
      watermark: 1,
      sourceRevision: 1,
      document: {
        body: target.endsWith("task-contract.json") ? contractBody : planBody,
        workspaceRevision: 1,
        blobSha256: `sha256:${"c".repeat(64)}`,
      },
    }),
  } as unknown as TaskProjection;
}

test("start and dispatch admission name an unavailable preset snapshot and its migration command", () => {
  for (const transition of ["task.start", "runtime.run"])
    assert.throws(
      () =>
        assertTaskTransitionDocumentReady({
          rootDir: "/tmp",
          projection: admissionProjection({
            taskId: "task-1",
            taskClass: "standard",
            status: "planned",
            currentNode: "implementation",
            presetSnapshotDigest: `sha256:${"a".repeat(64)}`,
            presetSnapshotGap: { reason: "snapshot-bytes-unavailable", sourceGeneration: 2, sourceRevision: 1 },
            metadata: { presetId: "standard-task" },
          }),
          taskId: "task-1",
          slot: "task.plan",
          transition,
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "document_invalid" &&
        /ha task contract migrate --task task-1 --to-preset standard-task --apply/u.test(error.message),
      transition,
    );
});

test("start admission still reads the plan of a task with a usable contract", () => {
  const document = assertTaskTransitionDocumentReady({
    rootDir: "/tmp",
    projection: admissionProjection({
      taskId: "task-1",
      taskClass: "standard",
      status: "planned",
      currentNode: "implementation",
      presetSnapshotDigest: `sha256:${"a".repeat(64)}`,
      metadata: { presetId: "standard-task" },
    }),
    taskId: "task-1",
    slot: "task.plan",
    transition: "task.start",
  });
  assert.equal(document.body, realizedPlan());
});

const fixPlanAnchors = [...planHeadings, "Recurrence Gate"].map((section) => `## ${section}`);

test("fix admission refuses a plan whose Recurrence Gate is missing or left as scaffold", () => {
  const template = readFileSync(
      new URL("../../preset/assets/software-coding/templates/task.plan.v2/en-US.md", import.meta.url),
      "utf8",
    ),
    gateScaffold = transitionDocumentContract(template).scaffoldBySection["Recurrence Gate"]?.[0],
    task = {
      taskId: "task-1",
      taskClass: "standard",
      status: "planned",
      currentNode: "implementation",
      presetSnapshotDigest: `sha256:${"a".repeat(64)}`,
      metadata: { presetId: "standard-task", workKind: "fix" },
    } as const;
  assert.ok(gateScaffold, "the template carries a Recurrence Gate scaffold");
  const cases = [
    ["missing", realizedPlan(), { section: "Recurrence Gate", reason: "empty" }],
    [
      "scaffold",
      `${realizedPlan()}\n\n## Recurrence Gate\n\n${gateScaffold}\n`,
      { section: "Recurrence Gate", reason: "scaffold", retainedScaffold: gateScaffold.slice(0, 60) },
    ],
  ] as const;
  for (const [name, body, expected] of cases)
    assert.throws(
      () =>
        assertTaskTransitionDocumentReady({
          rootDir: "/tmp",
          projection: admissionProjection(task, body, fixPlanAnchors),
          taskId: "task-1",
          slot: "task.plan",
          transition: "task.start",
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error, name);
        assert.equal((error as { readonly code?: unknown }).code, "plan_placeholder", name);
        assert.deepEqual((error as { readonly missingSections?: unknown }).missingSections, [expected], name);
        return true;
      },
      name,
    );
  const filled = `${realizedPlan()}\n\n## Recurrence Gate\n\nCriterion: a fix plan can omit its gate.\nGate: task-plan readiness.\nPositive control: a plan without this section is refused.\n`,
    document = assertTaskTransitionDocumentReady({
      rootDir: "/tmp",
      projection: admissionProjection(task, filled, fixPlanAnchors),
      taskId: "task-1",
      slot: "task.plan",
      transition: "task.start",
    });
  assert.equal(document.body, filled);
});

test("non-fix admission keeps the Recurrence Gate optional", () => {
  const document = assertTaskTransitionDocumentReady({
    rootDir: "/tmp",
    projection: admissionProjection({
      taskId: "task-1",
      taskClass: "standard",
      status: "planned",
      currentNode: "implementation",
      presetSnapshotDigest: `sha256:${"a".repeat(64)}`,
      metadata: { presetId: "standard-task", workKind: "feat" },
    }),
    taskId: "task-1",
    slot: "task.plan",
    transition: "task.start",
  });
  assert.equal(document.body, realizedPlan());
});
