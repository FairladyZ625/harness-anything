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
): { readonly policyIds: readonly string[]; readonly blocked: readonly string[] } {
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
      });
  // A persisted row whose path shape names no document (`application/json` outside the artifacts
  // subtree) cannot be submitted by either channel; the edge reports it for the operator, exactly as
  // the local scanner does, instead of the byte-decided silent skip. Byte-decided, this case was a
  // change under the decodable edit and an invisible non-event under the NUL edit.
  assert.deepEqual(scanFixture(OPAQUE_TEXTUAL_POLICY_ID, "context/architecture/notes.json", decodableEdit), {
    policyIds: [OPAQUE_TEXTUAL_POLICY_ID],
    blocked: [],
  });
  assert.deepEqual(scanFixture(OPAQUE_TEXTUAL_POLICY_ID, "context/architecture/notes.json", persistedBody), {
    policyIds: [],
    blocked: ["path is not an allowed canonical document"],
  });
  // A persisted raw row is not rescued by the path judgment: its bytes still decide.
  assert.deepEqual(scanFixture(RAW_ARTIFACT_POLICY_ID, binaryNamed, editedBody), {
    policyIds: [RAW_ARTIFACT_POLICY_ID],
    blocked: [],
  });
  // A name that claims a text format but holds undecodable bytes is still a broken document, not a
  // new artifact: the classifier answers null, so no persisted row means no membership. The center
  // answers `inapplicable` for it; the edge reports it so the operator sees the file instead of a
  // silent no-op.
  assert.deepEqual(scanFixture(null, textNamed, editedBody), {
    policyIds: [],
    blocked: ["path is not an allowed canonical document"],
  });
  // A brand-new binary artifact at a raw name is still accepted, byte-decided.
  assert.deepEqual(scanFixture(null, "tasks/task_policy/artifacts/screenshots/shot.png", editedBody), {
    policyIds: [RAW_ARTIFACT_POLICY_ID],
    blocked: [],
  });
  // A path with no persisted row is a member exactly when the shared candidate classifier recognizes
  // it, so the edge answers what the center's scanner already answers for the same path and bytes.
  // `context/architecture/notes.json` and `artifacts/data/rows.json` are both `eligible` +
  // `doc-submit: applied` at the center; blocking them here made every task command fail until the
  // center created the row first — the extra round-trip this task exists to remove.
  assert.deepEqual(scanFixture(null, "context/architecture/notes.json", decodableEdit), {
    policyIds: [OPAQUE_TEXTUAL_POLICY_ID],
    blocked: [],
  });
  assert.deepEqual(scanFixture(null, "tasks/task_policy/artifacts/data/rows.json", decodableEdit), {
    policyIds: [OPAQUE_TEXTUAL_POLICY_ID],
    blocked: [],
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
    });
  // A name that claims a text format but holds undecodable bytes is still a broken document, not a
  // new artifact. The center answers `inapplicable` for it; the edge reports it so the operator sees
  // the file instead of a silent no-op.
  assert.deepEqual(scanFixture(null, textNamed, editedBody), {
    policyIds: [],
    blocked: ["path is not an allowed canonical document"],
  });
  // `.md`/`.txt` rows stay in channel everywhere, so a persisted opaque `.md` still submits. Its
  // policy is the path judgment's answer (canonical prose), exactly as the local scanner answers; the
  // center decides whether that is an admissible upgrade of the persisted row.
  assert.deepEqual(scanFixture(OPAQUE_TEXTUAL_POLICY_ID, "context/nul-notes.md", editedBody), {
    policyIds: ["markdown-body-replaceable/v1"],
    blocked: [],
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
