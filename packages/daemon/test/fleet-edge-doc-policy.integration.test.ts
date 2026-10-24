// harness-test-tier: integration
// The edge does not re-judge a persisted document from its bytes. Before the artifacts subtree judged
// bytes, the write boundary classified by path, so a `.txt`/`.md` artifact could be persisted under
// `opaque-textual-whole-file/v1` with a NUL byte in it. Today's byte judgment calls that non-textual;
// an edge that asked only the byte classifier would block the row (mirror) or re-submit it as raw
// (center: `semantic_policy_changed`). The persisted policy travels with the replica row and decides.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeTaskEventReader,
  OPAQUE_TEXTUAL_POLICY_ID,
  RAW_ARTIFACT_POLICY_ID,
  sha256Bytes,
} from "@harness-anything/kernel";
import { readEdgeDocWorkspace } from "../src/fleet-edge-doc-read.ts";
import { locateFleetMirrorView, scanFleetMirrorWorktree, type FleetMirrorView } from "../src/fleet-edge-mirror.ts";
import { dualSyncFixture } from "./fleet-dual-sync.fixture.ts";

// Real shape of the row: valid UTF-8 (a NUL byte decodes) written under the opaque textual policy.
const persistedBody = Buffer.concat([Buffer.from("report line one\n"), Buffer.from([0x00]), Buffer.from("tail\n")]),
  editedBody = persistedBody,
  // The reviewer's real row, plain-text edited: the same persisted document on the other side of the
  // byte rule. Its status must not depend on which side the edit lands.
  decodableEdit = Buffer.from("report line one\ntail\ntrailing note\n");

function scanFixture(
  policyId: string | null,
  logical: string,
  bytes: Buffer,
): {
  readonly policyIds: readonly string[];
  readonly blocked: readonly string[];
  readonly blockedRoutes: readonly (string | undefined)[];
  readonly blockedCodes: readonly (string | undefined)[];
} {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-doc-policy-"));
  try {
    mkdirSync(path.join(root, "harness"), { recursive: true });
    writeFileSync(
      path.join(root, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: policy\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    const target = path.join(root, "harness", ...logical.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    const view: FleetMirrorView = {
      repoId: "policy-repo",
      viewId: "policy-node",
      viewDir: path.join(root, "view"),
      revision: 1,
      schemaGeneration: 1,
      headDigest: `sha256:${"0".repeat(64)}`,
      manifestDigest: `sha256:${"1".repeat(64)}:0`,
      ledgerGeneration: 1,
      readerProfile: null,
      authorizationShapeDigest: "",
      entries:
        policyId === null
          ? new Map()
          : new Map([
              [
                logical,
                {
                  sha256: sha256Bytes(Buffer.from("base bytes\n")),
                  size: Buffer.byteLength("base bytes\n"),
                  mediaType: "text/x-harness-opaque",
                  policyId,
                },
              ],
            ]),
    };
    const scan = scanFleetMirrorWorktree(view, root, [logical]);
    return {
      policyIds: scan.changes.map((change) => change.policyId),
      blocked: scan.blocked.map((row) => row.reason),
      blockedRoutes: scan.blocked.map((row) => row.requiredRoute),
      blockedCodes: scan.blocked.map((row) => row.code),
      inapplicable: scan.inapplicablePaths,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("an edge scan keeps a persisted textual row's policy instead of re-judging its bytes", () => {
  const textNamed = "tasks/task_policy/artifacts/notes/report.txt",
    binaryNamed = "tasks/task_policy/artifacts/notes/preview.pdf",
    rawNamed = "tasks/task_policy/artifacts/logs/run.log";
  // A persisted row is a member on its own terms, whatever its name and whatever its bytes read as
  // today. The reviewer's real row is exactly this shape — a `.log` the center wrote under the opaque
  // policy, edited to bytes that decode as plain text. Deciding membership by bytes silently dropped
  // it (the command then reported `no_changes` + ok) while the same row with one NUL byte submitted,
  // so the status of one persisted document flipped with the bytes of the edit. Both byte outcomes
  // now reach the same exit the local scanner reaches.
  for (const logical of [
    textNamed,
    binaryNamed,
    rawNamed,
    "tasks/task_44d5009838e66ef1dcb7c6c3b3-migration-entity-backfill/artifacts/production-dryrun-resolved-20260901.log",
    "tasks/task_policy/artifacts/data/rows.json",
  ])
    for (const bytes of [decodableEdit, persistedBody])
      assert.deepEqual(scanFixture(OPAQUE_TEXTUAL_POLICY_ID, logical, bytes), {
        policyIds: [OPAQUE_TEXTUAL_POLICY_ID],
        blocked: [],
        blockedRoutes: [],
        blockedCodes: [],
        inapplicable: [],
      });
  // A persisted row whose path shape names no document (`application/json` outside the artifacts
  // subtree) cannot be submitted by either channel; the edge reports it for the operator, exactly as
  // the local scanner does, instead of the byte-decided silent skip. Byte-decided, this case was a
  // change under the decodable edit and an invisible non-event under the NUL edit.
  assert.deepEqual(scanFixture(OPAQUE_TEXTUAL_POLICY_ID, "context/architecture/notes.json", decodableEdit), {
    policyIds: [OPAQUE_TEXTUAL_POLICY_ID],
    blocked: [],
    blockedRoutes: [],
    blockedCodes: [],
    inapplicable: [],
  });
  assert.deepEqual(scanFixture(OPAQUE_TEXTUAL_POLICY_ID, "context/architecture/notes.json", persistedBody), {
    policyIds: [],
    blocked: ["path is not an allowed canonical document"],
    blockedRoutes: [undefined],
    blockedCodes: [undefined],
    inapplicable: [],
  });
  // A persisted raw row is not rescued by the path judgment: its bytes still decide.
  assert.deepEqual(scanFixture(RAW_ARTIFACT_POLICY_ID, binaryNamed, editedBody), {
    policyIds: [RAW_ARTIFACT_POLICY_ID],
    blocked: [],
    blockedRoutes: [],
    blockedCodes: [],
    inapplicable: [],
  });
  // A name that claims a text format but holds undecodable bytes with no persisted row is a broken
  // document, not a new artifact — and, exactly like every other path the shared classifier does not
  // recognize while no route owns it, the center answers `inapplicable` and proceeds. The edge used
  // to refuse it, which turned one stray `.txt` into `preview_blocked` for the whole package.
  assert.deepEqual(scanFixture(null, textNamed, editedBody), {
    policyIds: [],
    blocked: [],
    blockedRoutes: [],
    blockedCodes: [],
    inapplicable: [textNamed],
  });
  // A brand-new binary artifact at a raw name is still accepted, byte-decided.
  assert.deepEqual(scanFixture(null, "tasks/task_policy/artifacts/screenshots/shot.png", editedBody), {
    policyIds: [RAW_ARTIFACT_POLICY_ID],
    blocked: [],
    blockedRoutes: [],
    blockedCodes: [],
    inapplicable: [],
  });
  // A path with no persisted row is a member exactly when the shared candidate classifier recognizes
  // it, so the edge answers what the center's scanner already answers for the same path and bytes.
  // `context/architecture/notes.json` and `artifacts/data/rows.json` are both `eligible` +
  // `doc-submit: applied` at the center; blocking them here made every task command fail until the
  // center created the row first — the extra round-trip this task exists to remove.
  assert.deepEqual(scanFixture(null, "context/architecture/notes.json", decodableEdit), {
    policyIds: [OPAQUE_TEXTUAL_POLICY_ID],
    blocked: [],
    blockedRoutes: [],
    blockedCodes: [],
    inapplicable: [],
  });
  assert.deepEqual(scanFixture(null, "tasks/task_policy/artifacts/data/rows.json", decodableEdit), {
    policyIds: [OPAQUE_TEXTUAL_POLICY_ID],
    blocked: [],
    blockedRoutes: [],
    blockedCodes: [],
    inapplicable: [],
  });
  // The evidence files a task package gains while the work is running are first publications too:
  // `.log`, `.json` and `.csv` under `artifacts/` are candidates on both sides.
  for (const evidence of [
    "tasks/task_policy/artifacts/evidence/probe-run.log",
    "tasks/task_policy/artifacts/reports/dispatch_probe.json",
    "tasks/task_policy/artifacts/evidence/rows.csv",
  ])
    assert.deepEqual(scanFixture(null, evidence, decodableEdit), {
      policyIds: [OPAQUE_TEXTUAL_POLICY_ID],
      blocked: [],
      blockedRoutes: [],
      blockedCodes: [],
      inapplicable: [],
    });
  // The class F7 is about, and the reason it is a regression rather than a preference: a file inside
  // a task package but *outside* `artifacts/` whose bytes the shared classifier does not recognize,
  // with no persisted row. The center answers `inapplicable` and proceeds (`doc-sync-candidate-scanner`:
  // "not doc-sync business at all"); the edge used to answer `blocked`, and both edge task-command
  // gates refuse on any non-route-owned block, so one stray screenshot refused `task-start`,
  // `task-progress-append`, `doc-submit` and `task-submit` for the whole package. Live tree evidence:
  // `tasks/task_cbf1e9c598ec9d571e63c8db6c-packaged-desktop-startup/evidence/shell-graph.png`.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 0xab)]),
    dsStore = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31, 0x00, 0x00, 0x10, 0x00]);
  for (const stray of [
    "tasks/task_policy/evidence/shot.png",
    "tasks/task_policy/evidence/shell-graph.png",
    "tasks/task_policy/.DS_Store",
    "tasks/task_policy/notes/raw.bin",
  ])
    assert.deepEqual(
      scanFixture(null, stray, stray.endsWith(".DS_Store") ? dsStore : stray.endsWith(".bin") ? dsStore : png),
      { policyIds: [], blocked: [], blockedRoutes: [], blockedCodes: [], inapplicable: [stray] },
      stray,
    );
  // A NUL-bearing `.txt` with no persisted row inside `artifacts/` is the same class: the name claims
  // text, the bytes are undecodable, the classifier answers null, and the center says `inapplicable`.
  // (`textNamed` above is that case; its review probe was `artifacts/evidence/run.txt`.)
  assert.deepEqual(scanFixture(null, "tasks/task_policy/artifacts/evidence/run.txt", persistedBody), {
    policyIds: [],
    blocked: [],
    blockedRoutes: [],
    blockedCodes: [],
    inapplicable: ["tasks/task_policy/artifacts/evidence/run.txt"],
  });
  // Route ownership remains attributed: `objects/` belongs to the content-blob route, so this channel
  // is not the one to answer for it. The edge preserves the center's route owner rather than losing
  // it in the non-member exit.
  assert.deepEqual(scanFixture(null, "objects/payload.png", png), {
    policyIds: [],
    blocked: ["path is owned by content-blob"],
    blockedRoutes: ["content-blob"],
    blockedCodes: ["doc_route_owned"],
    inapplicable: [],
  });
  // `.md`/`.txt` rows stay in channel everywhere, so a persisted opaque `.md` still submits. Its
  // policy is the path judgment's answer (canonical prose), exactly as the local scanner answers; the
  // center decides whether that is an admissible upgrade of the persisted row.
  assert.deepEqual(scanFixture(OPAQUE_TEXTUAL_POLICY_ID, "context/nul-notes.md", editedBody), {
    policyIds: ["markdown-body-replaceable/v1"],
    blocked: [],
    blockedRoutes: [],
    blockedCodes: [],
    inapplicable: [],
  });
  // A path another route owns is reported with that route, not as a doc-channel refusal. The task
  // lifecycle writes `INDEX.md` and `executions/*.md` itself; when they drift locally the scan must
  // name `task-lifecycle` so callers can exclude them instead of failing every `task-start` and
  // `task-submit` with `preview_blocked` (the shard-3 `fleet-review-rework` failure).
  for (const [owned, requiredRoute] of [
    ["tasks/task_policy/INDEX.md", "task-lifecycle"],
    ["tasks/task_policy/executions/exe-1.md", "task-lifecycle"],
    ["tasks/task_policy/progress.md", "task-progress-append"],
  ] as const)
    assert.deepEqual(scanFixture(null, owned, Buffer.from("edited locally\n")), {
      policyIds: [],
      blocked: [`path is owned by ${requiredRoute}`],
      blockedRoutes: [requiredRoute],
      blockedCodes: ["doc_route_owned"],
      inapplicable: [],
    });
  // A route-owned path the doc channel does not recognize is still attributed to its owner; losing
  // that identity turns the package-wide task gate into a false refusal.
  assert.deepEqual(scanFixture(null, "tasks/task_policy/reviews/.DS_Store", dsStore), {
    policyIds: [],
    blocked: ["path is owned by task-review-execution"],
    blockedRoutes: ["task-review-execution"],
    blockedCodes: ["doc_route_owned"],
    inapplicable: [],
  });
  // `doc_route_owned` is not a blanket exemption from the block gate: a document this channel does
  // own but cannot carry inline still reports `doc_candidate_too_large` and no route ownership, so
  // callers keep refusing it.
  assert.deepEqual(scanFixture(null, "context/huge.md", Buffer.alloc(256 * 1024 + 1, 0x61)), {
    policyIds: [],
    blocked: ["document exceeds inline limit"],
    blockedRoutes: ["blob-content"],
    blockedCodes: ["doc_candidate_too_large"],
    inapplicable: [],
  });
  const oversizeEvidence = "tasks/task_policy/evidence/dump.json";
  assert.deepEqual(scanFixture(null, oversizeEvidence, Buffer.alloc(256 * 1024 + 1, 0x61)), {
    policyIds: [],
    blocked: [],
    blockedRoutes: [],
    blockedCodes: [],
    inapplicable: [oversizeEvidence],
  });
});

test(
  "an edge submit of a persisted NUL-bearing .txt keeps its opaque policy through the center",
  { timeout: 90_000 },
  async (t) => {
    const fixture = await dualSyncFixture();
    t.after(() => fixture.close());
    const created = await fixture.createTask("node-one", "task-edge-policy", "Edge persisted policy"),
      logical = `${created.packagePath}/artifacts/notes/report.txt`,
      source = path.join(fixture.repo, "edge-policy-source.txt");
    // The persisted row is real: the center accepted this path under the opaque textual policy while
    // it still held decodable text. The edge now edits it to bytes that carry a NUL, which today's
    // byte judgment calls non-textual.
    writeFileSync(source, "report line one\ntail\n");
    const seeded = await fixture.centerRun({
      kind: "task-artifact-add",
      taskId: created.taskId,
      source: "edge-policy-source.txt",
      destination: "notes/report.txt",
    });
    assert.equal(seeded.outcome, "applied", JSON.stringify(seeded).slice(0, 600));
    await fixture.waitPublished(String(seeded.opId));
    assert.equal((await fixture.edgeDocSync("node-one")).ok, true);
    const target = fixture.worktree("node-one", logical);
    assert.deepEqual(readFileSync(target), Buffer.from("report line one\ntail\n"));
    writeFileSync(target, persistedBody);
    assert.equal(sha256Bytes(readFileSync(target)), sha256Bytes(persistedBody), "local edit is the NUL-bearing row");

    // A task-package document cannot ride the bare edge `doc-submit` channel
    // (`task_docs_require_task_command`); it rides the canonical task command's carried docChanges,
    // which is the edge path that recomputed the policy from bytes before this fix.
    const carried = await fixture.edgeTask("node-one", {
      kind: "task-start",
      taskId: created.taskId,
      executionId: "exe-edge-policy",
    });
    assert.equal(carried.ok, true, JSON.stringify(carried).slice(0, 800));
    assert.equal(
      sha256Bytes(readFileSync(target)),
      sha256Bytes(persistedBody),
      "the carried edit is still the NUL-bearing row after the task command",
    );
    await fixture.waitPublished(String(carried.opId));
    // The carried edit lands in the task event's carriedDocumentClaims, not a separate doc event:
    // one serial command, lifecycle and documents in the same canonical commit.
    const submittedEvent = makeTaskEventReader({ repoId: "dual-repo", rootDir: fixture.repo })
        .read()
        .events.filter((event) => JSON.stringify(event.payload).includes(`"path":"${logical}"`))
        .at(-1),
      payload = submittedEvent?.payload as
        | { readonly carriedDocumentClaims?: readonly Record<string, unknown>[] }
        | undefined,
      submittedChange = payload?.carriedDocumentClaims?.find((claim) => claim.path === logical) as
        | { readonly policyId?: string; readonly candidate?: { readonly sha256?: string; readonly mediaType?: string } }
        | undefined;
    assert.deepEqual(
      [submittedChange?.policyId, submittedChange?.candidate?.mediaType, submittedChange?.candidate?.sha256],
      [OPAQUE_TEXTUAL_POLICY_ID, "text/plain", sha256Bytes(persistedBody)],
      JSON.stringify(carried).slice(0, 800),
    );
    assert.equal(
      (submittedEvent?.payload as { readonly carriedDocumentClaims?: unknown }).carriedDocumentClaims !== undefined,
      true,
    );
  },
);

test(
  "an edge task command carries a persisted opaque .log row edited to decodable text",
  { timeout: 90_000 },
  async (t) => {
    // The reviewer's real row: `.../artifacts/production-dryrun-resolved-20260901.log`, persisted under
    // `opaque-textual-whole-file/v1` with `text/x-harness-opaque`. Its name is neither `.md`/`.txt` nor
    // a binary-table name, so a byte-decided membership test reads the plain-text edit as opaque-textual
    // and drops it: the command then reports `no_changes` + ok while the local edit never lands. The
    // same document carrying a NUL byte submits, so the row's status would flip on the edit's bytes.
    const fixture = await dualSyncFixture();
    t.after(() => fixture.close());
    const created = await fixture.createTask("node-one", "task-edge-log-policy", "Edge opaque log policy"),
      logical = `${created.packagePath}/artifacts/production-dryrun-resolved.log`,
      source = path.join(fixture.repo, "edge-policy-log-source.log"),
      decodableEdit = "report line one\ntail\ntrailing note\n";
    writeFileSync(source, "report line one\ntail\n");
    const seeded = await fixture.centerRun({
      kind: "task-artifact-add",
      taskId: created.taskId,
      source: "edge-policy-log-source.log",
      destination: "production-dryrun-resolved.log",
    });
    assert.equal(seeded.outcome, "applied", JSON.stringify(seeded).slice(0, 600));
    await fixture.waitPublished(String(seeded.opId));
    assert.equal((await fixture.edgeDocSync("node-one")).ok, true);
    const target = fixture.worktree("node-one", logical);
    // The center wrote the row under the opaque policy although its bytes decode as text.
    assert.equal(readFileSync(target, "utf8"), "report line one\ntail\n");
    writeFileSync(target, decodableEdit);

    const carried = await fixture.edgeTask("node-one", {
      kind: "task-start",
      taskId: created.taskId,
      executionId: "exe-edge-log-policy",
    });
    assert.equal(carried.ok, true, JSON.stringify(carried).slice(0, 800));
    await fixture.waitPublished(String(carried.opId));
    const submittedEvent = makeTaskEventReader({ repoId: "dual-repo", rootDir: fixture.repo })
        .read()
        .events.filter((event) => JSON.stringify(event.payload).includes(`"path":"${logical}"`))
        .at(-1),
      payload = submittedEvent?.payload as
        | { readonly carriedDocumentClaims?: readonly Record<string, unknown>[] }
        | undefined,
      submittedChange = payload?.carriedDocumentClaims?.find((claim) => claim.path === logical) as
        | { readonly policyId?: string; readonly candidate?: { readonly sha256?: string; readonly mediaType?: string } }
        | undefined;
    // The decodable edit is carried under the policy the center wrote the row with, not dropped and not
    // reclassified as a raw artifact.
    assert.deepEqual(
      [submittedChange?.policyId, submittedChange?.candidate?.mediaType, submittedChange?.candidate?.sha256],
      [OPAQUE_TEXTUAL_POLICY_ID, "text/x-harness-opaque", sha256Bytes(Buffer.from(decodableEdit))],
      JSON.stringify(carried).slice(0, 800),
    );
  },
);

test("an edge task-start carries a persisted raw .log row edited to decodable text", { timeout: 90_000 }, async (t) => {
  const fixture = await dualSyncFixture();
  t.after(() => fixture.close());
  const created = await fixture.createTask("node-one", "task-edge-raw-policy", "Edge raw policy"),
    logical = `${created.packagePath}/artifacts/production-dryrun-resolved.log`,
    source = path.join(fixture.repo, "edge-raw-policy-source.log"),
    rawBytes = Buffer.from([0x80]),
    decodableEdit = Buffer.from("report line one\ntail\ntrailing note\n");
  writeFileSync(source, rawBytes);
  const seeded = await fixture.centerRun({
    kind: "task-artifact-add",
    taskId: created.taskId,
    source: "edge-raw-policy-source.log",
    destination: "production-dryrun-resolved.log",
  });
  assert.equal(seeded.outcome, "applied", JSON.stringify(seeded).slice(0, 600));
  await fixture.waitPublished(String(seeded.opId));
  const seededEvent = makeTaskEventReader({ repoId: "dual-repo", rootDir: fixture.repo }).readEvent(
      String(seeded.opId),
    ),
    seededPayload = seededEvent?.payload as { readonly changes?: readonly Record<string, unknown>[] } | undefined;
  assert.equal(seededPayload?.changes?.[0]?.policyId, RAW_ARTIFACT_POLICY_ID);
  assert.equal((await fixture.edgeDocSync("node-one")).ok, true);
  const target = fixture.worktree("node-one", logical);
  assert.equal(
    locateFleetMirrorView(path.join(fixture.root, "node-one-edge"), "dual-repo", "node-one")?.entries.get(logical)
      ?.policyId,
    RAW_ARTIFACT_POLICY_ID,
    "the replica row retains the raw policy used for membership",
  );
  assert.deepEqual(readFileSync(target), rawBytes);
  writeFileSync(target, decodableEdit);

  const started = await fixture.edgeTask("node-one", {
    kind: "task-start",
    taskId: created.taskId,
    executionId: "exe-edge-raw-policy",
  });
  assert.equal(started.ok, true, JSON.stringify(started).slice(0, 800));
  await fixture.waitPublished(String(started.opId));
  const submittedEvent = makeTaskEventReader({ repoId: "dual-repo", rootDir: fixture.repo })
      .read()
      .events.filter((event) => JSON.stringify(event.payload).includes(`"path":"${logical}"`))
      .at(-1),
    payload = submittedEvent?.payload as
      | { readonly carriedDocumentClaims?: readonly Record<string, unknown>[] }
      | undefined,
    submittedChange = payload?.carriedDocumentClaims?.find((claim) => claim.path === logical) as
      | { readonly policyId?: string; readonly candidate?: { readonly sha256?: string; readonly mediaType?: string } }
      | undefined;
  assert.deepEqual(
    [submittedChange?.policyId, submittedChange?.candidate?.mediaType, submittedChange?.candidate?.sha256],
    [OPAQUE_TEXTUAL_POLICY_ID, "text/x-harness-opaque", sha256Bytes(decodableEdit)],
    JSON.stringify(started).slice(0, 800),
  );
  // The reviewer's probe, as a regression: a task package gains new evidence during the work —
  // `.log`, `.json`, `.csv` under `artifacts/`, none with a persisted row yet. The center classifies
  // all three as candidates; before the shared membership rule the edge blocked them and every task
  // command failed until the center had created a row first, which is the extra round-trip this task
  // deletes. The same command must now carry them and their bytes must land.
  const fresh = [
    `${created.packagePath}/artifacts/evidence/probe-run.log`,
    `${created.packagePath}/artifacts/reports/dispatch_probe.json`,
    `${created.packagePath}/artifacts/evidence/rows.csv`,
  ];
  for (const logical of fresh) fixture.writeWorktree("node-one", logical, '{"probe":true}\n');
  const carriedFresh = await fixture.edgeTask("node-one", {
    kind: "task-progress-append",
    taskId: created.taskId,
    text: "fresh evidence",
  });
  assert.equal(carriedFresh.ok, true, JSON.stringify(carriedFresh).slice(0, 800));
  await fixture.waitPublished(String(carriedFresh.opId));
  const progressEvent = makeTaskEventReader({ repoId: "dual-repo", rootDir: fixture.repo }).readEvent(
      String(carriedFresh.opId),
    ),
    carriedChanges = (
      progressEvent?.payload as { readonly carriedDocumentClaims?: readonly Record<string, unknown>[] } | undefined
    )?.carriedDocumentClaims;
  for (const logical of fresh) {
    const change = carriedChanges?.find((claim) => claim.path === logical) as
      | { readonly policyId?: string; readonly candidate?: { readonly sha256?: string } }
      | undefined;
    assert.deepEqual(
      [change?.policyId, change?.candidate?.sha256],
      [OPAQUE_TEXTUAL_POLICY_ID, sha256Bytes(Buffer.from('{"probe":true}\n'))],
      `${logical}: ${JSON.stringify(carriedFresh).slice(0, 800)}`,
    );
  }
});

test(
  "a stray binary outside artifacts/ does not refuse the package's task commands",
  { timeout: 90_000 },
  async (t) => {
    // F7 review finding, end to end on the real dual-node fixture. A file inside the task package but
    // outside `artifacts/` — the shape of a screenshot saved next to the plan, a `.DS_Store`, a
    // NUL-bearing note — has no persisted row and bytes the shared classifier does not recognize. The
    // center answers `inapplicable` and proceeds; the edge used to answer `blocked`, and both task
    // command gates refuse on any non-route-owned block, so one such file wedged `task-start`,
    // `task-progress-append` and `doc-submit` for the whole package. This test proves the two nodes
    // now agree by running the commands with the stray file present and comparing the center's answer
    // for the same path.
    const fixture = await dualSyncFixture();
    t.after(() => fixture.close());
    const created = await fixture.createTask("node-one", "task-edge-stray", "Edge stray binary"),
      stray = `${created.packagePath}/evidence/shot.png`,
      strayBytes = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(32, 0xab),
      ]),
      dsStore = `${created.packagePath}/.DS_Store`,
      routeOwnedStray = `${created.packagePath}/reviews/.DS_Store`,
      oversizeEvidence = `${created.packagePath}/evidence/dump.json`,
      oversizeBytes = Buffer.alloc(256 * 1024 + 1, 0x61);
    // Write the bytes, not a string: the point is undecodable content at a name the classifier does
    // not resolve inside the package's non-artifacts subtree.
    for (const [logical, bytes] of [
      [stray, strayBytes],
      [dsStore, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31, 0x00, 0x00, 0x10, 0x00])],
      [routeOwnedStray, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31, 0x00, 0x00, 0x10, 0x00])],
      [oversizeEvidence, oversizeBytes],
    ] as const) {
      const target = fixture.worktree("node-one", logical),
        parent = path.dirname(target);
      mkdirSync(parent, { recursive: true });
      writeFileSync(target, bytes);
    }
    // The center's own answer for the same path and bytes: `inapplicable`, not blocked. This is the
    // comparison that makes the edge's old `blocked` a divergence rather than a preference.
    const centerStatus = await fixture.centerRun({ kind: "doc-status", paths: [stray] }),
      centerRows = JSON.parse(String(centerStatus.evidence).slice("doc-scan:".length)) as {
        readonly rows: readonly { readonly path: string; readonly state: string }[];
      },
      centerRow = centerRows.rows.find((row) => row.path === stray);
    assert.deepEqual(
      [centerRow?.state, centerRow?.reason ?? null],
      ["inapplicable", "path is not a supported textual document"],
      JSON.stringify(centerStatus).slice(0, 800),
    );
    const oversizeStatus = await fixture.centerRun({ kind: "doc-status", paths: [oversizeEvidence] }),
      oversizeRows = JSON.parse(String(oversizeStatus.evidence).slice("doc-scan:".length)) as {
        readonly rows: readonly { readonly path: string; readonly state: string; readonly reason: string | null }[];
      },
      oversizeRow = oversizeRows.rows.find((row) => row.path === oversizeEvidence);
    assert.deepEqual(
      [oversizeRow?.state, oversizeRow?.reason ?? null],
      ["inapplicable", "path is not a supported textual document"],
      JSON.stringify(oversizeStatus).slice(0, 800),
    );
    const routeOwnedStatus = await fixture.centerRun({ kind: "doc-status", paths: [routeOwnedStray] }),
      routeOwnedRows = JSON.parse(String(routeOwnedStatus.evidence).slice("doc-scan:".length)) as {
        readonly rows: readonly { readonly path: string; readonly state: string; readonly reason: string | null }[];
      },
      routeOwnedRow = routeOwnedRows.rows.find((row) => row.path === routeOwnedStray);
    assert.deepEqual(
      [routeOwnedRow?.state, routeOwnedRow?.reason ?? null],
      ["blocked", "path is owned by task-review-execution"],
      JSON.stringify(routeOwnedStatus).slice(0, 800),
    );

    // With the stray files present, the package's commands must still work. `task-start` carries the
    // ordinary document set; before the fix it threw `preview_blocked` naming the stray png.
    const started = await fixture.edgeTask("node-one", {
      kind: "task-start",
      taskId: created.taskId,
      executionId: "exe-edge-stray",
    });
    assert.equal(started.ok, true, JSON.stringify(started).slice(0, 800));
    await fixture.waitPublished(String(started.opId));
    const progressed = await fixture.edgeTask("node-one", {
      kind: "task-progress-append",
      taskId: created.taskId,
      text: "stray binary present",
    });
    assert.equal(progressed.ok, true, JSON.stringify(progressed).slice(0, 800));
    await fixture.waitPublished(String(progressed.opId));
    // The stray bytes were never published: they are not this channel's business, which is exactly the
    // center's `inapplicable` answer. The worktree keeps the local file untouched.
    assert.deepEqual(readFileSync(fixture.worktree("node-one", stray)), strayBytes);
    const view = fixture.view("node-one");
    assert.equal(view?.entries.has(stray) ?? true, false, "an inapplicable path is never carried to the center");
    assert.equal(view?.entries.has(dsStore) ?? true, false, "an inapplicable .DS_Store is never carried");
    assert.equal(view?.entries.has(routeOwnedStray) ?? true, false, "a route-owned path stays outside this channel");
    assert.equal(view?.entries.has(oversizeEvidence) ?? true, false, "an oversize path is not read into this channel");
  },
);

test(
  "edge lifecycle commands leave unsupported, oversized, and deleted docs to the center's existing paths",
  { timeout: 180_000 },
  async (t) => {
    const fixture = await dualSyncFixture();
    t.after(() => fixture.close());
    const cases = [
      {
        name: "NUL-bearing .log",
        relativePath: "evidence/binary.log",
        initial: Buffer.from("seed log\n"),
        changed: Buffer.from([0x80, 0x00]),
      },
      {
        name: "300 KiB .log",
        relativePath: "evidence/large.log",
        initial: Buffer.from("seed log\n"),
        changed: Buffer.alloc(300 * 1024, 0x61),
      },
      {
        name: ">256 KiB design.md",
        relativePath: "notes/design.md",
        initial: Buffer.from("# Design\n"),
        changed: Buffer.alloc(256 * 1024 + 1, 0x61),
      },
      {
        name: "deleted design.md",
        relativePath: "notes/deleted-design.md",
        initial: Buffer.from("# Design\n"),
        changed: null,
      },
    ] as const;

    const outcomes: { readonly name: string; readonly center: string; readonly edge: string }[] = [];
    for (const [index, row] of cases.entries()) {
      const edgeTask = await fixture.createTask(
          "node-one",
          `task-edge-prescan-${index}`,
          `Edge pre-scan case ${index}`,
        ),
        centerTask = await fixture.createTask(
          "node-two",
          `task-center-prescan-${index}`,
          `Center pre-scan case ${index}`,
        ),
        edgePath = `${edgeTask.packagePath}/${row.relativePath}`,
        centerPath = `${centerTask.packagePath}/${row.relativePath}`;
      for (const logical of [edgePath, centerPath]) {
        const canonical = path.join(fixture.repo, "harness", ...logical.split("/"));
        mkdirSync(path.dirname(canonical), { recursive: true });
        writeFileSync(canonical, row.initial);
      }
      const seeded = await fixture.centerRun({ kind: "doc-submit", paths: [edgePath, centerPath] });
      assert.equal(seeded.outcome, "applied", `${row.name}: seed ${JSON.stringify(seeded).slice(0, 800)}`);
      await fixture.waitPublished(String(seeded.opId));
      assert.equal((await fixture.edgeDocSync("node-one")).ok, true);
      for (const logical of [edgePath, centerPath]) {
        const canonical = path.join(fixture.repo, "harness", ...logical.split("/")),
          edge = fixture.worktree("node-one", logical);
        if (row.changed === null) rmSync(canonical);
        else writeFileSync(canonical, row.changed);
        if (logical === edgePath) {
          if (row.changed === null) rmSync(edge);
          else writeFileSync(edge, row.changed);
        }
      }

      const edgeReceipt = await fixture
          .edgeTask("node-one", {
            kind: "task-start",
            taskId: edgeTask.taskId,
            executionId: `exe-edge-prescan-${index}`,
          })
          .then((receipt) => ({
            outcome: String(receipt.outcome ?? (receipt.ok ? "applied" : "rejected")),
            opId: typeof receipt.opId === "string" ? receipt.opId : null,
            detail: String(receipt.code ?? receipt.rejectionExplanation ?? ""),
          }))
          .catch((error: unknown) => ({
            outcome: `threw:${typeof error === "object" && error !== null && "code" in error ? String(error.code) : String(error)}`,
            opId: null,
            detail: error instanceof Error ? error.message : String(error),
          })),
        centerResult = await fixture.centerRun({
          kind: "task-start",
          taskId: centerTask.taskId,
          executionId: `exe-center-prescan-${index}`,
        });
      assert.equal(
        centerResult.outcome,
        "applied",
        `${row.name}: center ${JSON.stringify(centerResult).slice(0, 800)}`,
      );
      outcomes.push({
        name: row.name,
        center: String(centerResult.outcome),
        edge: `${edgeReceipt.outcome}${edgeReceipt.detail ? `:${edgeReceipt.detail}` : ""}`,
      });
      if (edgeReceipt.outcome === "applied" && edgeReceipt.opId !== null) await fixture.waitPublished(edgeReceipt.opId);
      await fixture.edgeDocSync("node-one");
    }
    assert.deepEqual(
      outcomes,
      cases.map((row) => ({ name: row.name, center: "applied", edge: "applied" })),
    );
  },
);

test("an edge doc-status reports a stray non-member as inapplicable, like the center, instead of hiding it", () => {
  // The scan now separates `inapplicable` from `blocked`; the edge's read surface must carry that
  // distinction too, or a file that no longer wedges commands would silently disappear from
  // `doc-status`. The center lists it as `inapplicable` with that reason, so the edge does the same.
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-doc-status-"));
  try {
    mkdirSync(path.join(root, "harness"), { recursive: true });
    writeFileSync(
      path.join(root, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: policy\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    const logical = "tasks/task_policy/evidence/shot.png",
      target = path.join(root, "harness", ...logical.split("/")),
      png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 0xab)]);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, png);
    const view: FleetMirrorView = {
      repoId: "policy-repo",
      viewId: "policy-node",
      viewDir: path.join(root, "view"),
      revision: 1,
      schemaGeneration: 1,
      headDigest: `sha256:${"0".repeat(64)}`,
      manifestDigest: `sha256:${"1".repeat(64)}:0`,
      ledgerGeneration: 1,
      readerProfile: null,
      authorizationShapeDigest: "",
      entries: new Map(),
    };
    const receipt = readEdgeDocWorkspace(root, view, {} as never, { kind: "doc-status", paths: [logical] } as never);
    assert.deepEqual(
      receipt.rows.map(({ path: rowPath, state, reason }) => [rowPath, state, reason]),
      [[logical, "inapplicable", "path is not a supported textual document"]],
      JSON.stringify(receipt.summary),
    );
    assert.match(receipt.summary, /inapplicable/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
