// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync as runGitInit, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AUTHORED_DOCUMENT_EVENT_FAMILY,
  aggregateEventFamiliesFromSnapshot,
  checkAggregateEventConstructionSites,
  loadAggregateEventFamilies,
  scanAggregateEventConstructionSites,
} from "./check-task-event-aggregate-entry.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

const TASK_FAMILIES = Object.freeze([
  {
    schema: "task-event/v1",
    owner: "task",
    writers: Object.freeze(["packages/kernel/src/domain/task-lifecycle-event.ts"]),
    types: Object.freeze([
      "task_created",
      "task_transitioned",
      "task_completed",
      "task_review_responded",
      "task_archived",
      "lease_released",
      "execution_started",
    ]),
  },
  {
    schema: "agent-runtime-event/v1",
    owner: "runtime-session",
    writers: Object.freeze(["packages/kernel/src/domain/agent-runtime-event.ts"]),
    types: null,
  },
  AUTHORED_DOCUMENT_EVENT_FAMILY,
]);

// The gate enumerates through git, so fixture roots must be repositories; the
// local excludesFile pin keeps the host user's global ignores out of the test.
function makeGateRoot(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  for (const args of [
    ["init", "--quiet"],
    ["config", "core.excludesFile", "/dev/null"],
  ])
    runGitInit("git", args, { cwd: root });
  return root;
}

function writeSource(root, rel, body) {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return rel;
}

function scanFixture(root, families = TASK_FAMILIES) {
  return scanAggregateEventConstructionSites(root, families);
}

function findingsFor(sites, families = TASK_FAMILIES) {
  return checkAggregateEventConstructionSites(sites, { families });
}

let repoFamilies;
function familiesForRepo() {
  return (repoFamilies ??= loadAggregateEventFamilies(repoRoot));
}

let repoSites;
function sitesForRepo() {
  return (repoSites ??= scanAggregateEventConstructionSites(repoRoot, familiesForRepo()));
}

test("gate accepts the repository with no exemptions", () => {
  const result = spawnSync("node", [path.join(repoRoot, "tools/check-task-event-aggregate-entry.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Aggregate event construction check passed \(\d+ sites, no exemptions\)/u);
  assert.deepEqual(
    checkAggregateEventConstructionSites(sitesForRepo(), {
      families: familiesForRepo(),
    }),
    [],
  );
});

test("a non-owner module constructing agent-runtime-event fails, the owner module passes", () => {
  const root = makeGateRoot("ha-aggregate-owner-");
  try {
    const body =
      'export const event = { schema: "agent-runtime-event/v1", type: "runtime_dispatch_requested", payload: {} };\n';
    writeSource(root, "packages/rogue/src/rogue.ts", body);
    const findings = findingsFor(scanFixture(root));
    assert.match(
      findings.join("\n"),
      /packages\/rogue\/src\/rogue\.ts.*outside the declared writers of runtime-session/u,
    );

    writeSource(root, "packages/kernel/src/domain/agent-runtime-event.ts", body);
    rmSync(path.join(root, "packages/rogue"), { recursive: true, force: true });
    assert.deepEqual(findingsFor(scanFixture(root)), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task event types must be declared and owner-prefixed types cannot hide outside writers", () => {
  const root = makeGateRoot("ha-aggregate-undeclared-");
  try {
    writeSource(
      root,
      "packages/rogue/src/rogue.ts",
      [
        'export const withSchema = { schema: "task-event/v1", type: "task_rogue", payload: {} };',
        'export const bare = { type: "task_rogue_payload" };',
        "",
      ].join("\n"),
    );
    const findings = findingsFor(scanFixture(root));
    assert.equal(
      findings.filter((finding) => finding.includes("is not declared by schema task-event/v1")).length,
      2,
      findings.join("\n"),
    );
    assert.match(findings.join("\n"), /task_rogue.*outside the declared writers/u);
    assert.match(findings.join("\n"), /task_rogue_payload.*outside the declared writers/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runtime aggregate constructor remains visible to schema-and-type discovery", () => {
  assert.ok(
    sitesForRepo().some(
      (site) =>
        site.schema === "agent-runtime-event/v1" &&
        site.path === "packages/kernel/src/domain/agent-runtime-event.ts" &&
        site.form === "dynamic-event",
    ),
  );
});

// dec_499E4E98A3D4754132B3BCA1E6 CH1: clearing the debt removes the
// exemption mechanism, including for authored-document's aggregate-local events.
test("a former baseline entry cannot authorize construction outside the owner", () => {
  const site = {
    schema: "task-event/v1",
    path: "packages/legacy/src/legacy.ts",
    form: "envelope-call",
    eventType: "task_created",
    line: 1,
    column: 1,
  };
  const findings = checkAggregateEventConstructionSites([site], {
    families: TASK_FAMILIES,
    baseline: { [`${site.schema}|${site.path}|${site.form}|${site.eventType}`]: 1 },
  });
  assert.match(findings.join("\n"), /outside the declared writers of task/u);
});

test("authored-document events are constructed only by their aggregate", () => {
  const root = makeGateRoot("ha-authored-document-entry-");
  try {
    const body = 'export const event = { schema: "authored-document-event/v1", type, payload };\n';
    writeSource(root, "packages/kernel/src/domain/authored-document.ts", body);
    assert.deepEqual(findingsFor(scanFixture(root)), []);
    writeSource(root, "packages/daemon/src/edge-plan-ready.ts", body);
    assert.match(
      findingsFor(scanFixture(root)).join("\n"),
      /edge-plan-ready\.ts.*outside the declared writers of document/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit event catalog retains one constructor per type inside its owner", () => {
  const root = makeGateRoot("ha-authored-document-single-constructor-");
  try {
    writeSource(
      root,
      "packages/kernel/src/domain/authored-document.ts",
      [
        'authoredDocumentEnvelope(command, "authored_document_revised", {});',
        'authoredDocumentEnvelope(command, "authored_document_revised", {});',
        "",
      ].join("\n"),
    );
    assert.match(findingsFor(scanFixture(root)).join("\n"), /duplicate aggregate constructor/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("families are derived from canonicalEventSchemas owners and their state-store writers", () => {
  const snapshot = {
    stateStores: [
      {
        kind: "task",
        stateStores: [
          {
            id: "task.task-events",
            role: "authority",
            medium: {
              kind: "canonical-event",
              schema: "task-event/v1",
              types: ["task_created", "task_archived"],
              writers: ["packages/kernel/src/domain/task-lifecycle-event.ts"],
            },
          },
        ],
      },
    ],
    canonicalEvents: [{ schema: "task-event/v1", owner: "task" }],
  };
  assert.deepEqual(aggregateEventFamiliesFromSnapshot(snapshot, []), [
    {
      schema: "task-event/v1",
      owner: "task",
      writers: ["packages/kernel/src/domain/task-lifecycle-event.ts"],
      types: ["task_created", "task_archived"],
    },
  ]);
  assert.throws(
    () =>
      aggregateEventFamiliesFromSnapshot(
        { stateStores: [], canonicalEvents: [{ schema: "peer-event/v1", owner: "task" }] },
        [],
      ),
    /has no authority canonical-event state store/u,
  );
  const wildcard = aggregateEventFamiliesFromSnapshot(
    {
      ...snapshot,
      stateStores: [
        {
          kind: "task",
          stateStores: [
            {
              ...snapshot.stateStores[0].stateStores[0],
              medium: { ...snapshot.stateStores[0].stateStores[0].medium, types: ["*"] },
            },
          ],
        },
      ],
    },
    [],
  );
  assert.equal(wildcard[0].types, null);
});

test("the deleted hand-written task allowlist cannot reappear", async () => {
  const gate = await import("./check-task-event-aggregate-entry.mjs"),
    source = readFileSync(path.join(repoRoot, "tools/check-task-event-aggregate-entry.mjs"), "utf8");
  assert.equal(Object.hasOwn(gate, "TASK_EVENT_CONSTRUCTION_ALLOWLIST"), false);
  assert.equal(Object.hasOwn(gate, "AUTHORED_DOCUMENT_EVENT_CONSTRUCTION_ALLOWLIST"), false);
  assert.doesNotMatch(source, /TASK_EVENT_CONSTRUCTION_ALLOWLIST|AUTHORED_DOCUMENT_EVENT_CONSTRUCTION_ALLOWLIST/u);
});

const requiredScanRoots = ["packages"];
for (const omitted of requiredScanRoots) {
  for (const state of ["missing", "empty", "excluded-only"]) {
    test(`check-task-event-aggregate-entry rejects ${state} required scan root ${omitted}`, () => {
      const root = makeGateRoot("ha-gate-discovery-");
      try {
        for (const scanRoot of requiredScanRoots) {
          if (scanRoot === omitted && state === "missing") continue;
          mkdirSync(path.join(root, scanRoot), { recursive: true });
          if (scanRoot !== omitted) writeFileSync(path.join(root, scanRoot, "good.ts"), "export const ok = true;\n");
          if (scanRoot === omitted && state === "excluded-only") {
            mkdirSync(path.join(root, scanRoot, "dist"), { recursive: true });
            writeFileSync(path.join(root, scanRoot, "dist/ignored.ts"), "export const ignored = true;\n");
            writeFileSync(path.join(root, ".gitignore"), "dist/\n");
          }
        }
        assert.throws(() => scanFixture(root), /no source files/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("zero constructors are legal when production source discovery is intact", () => {
  const root = makeGateRoot("ha-aggregate-clean-");
  try {
    writeSource(root, "packages/clean/src/good.ts", "export const ok = true;\n");
    assert.deepEqual(scanFixture(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
