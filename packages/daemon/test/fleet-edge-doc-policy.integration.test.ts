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
import { scanFleetMirrorWorktree, type FleetMirrorView } from "../src/fleet-edge-mirror.ts";
import { dualSyncFixture } from "./fleet-dual-sync.fixture.ts";

// Real shape of the row: valid UTF-8 (a NUL byte decodes) written under the opaque textual policy.
const persistedBody = Buffer.concat([Buffer.from("report line one\n"), Buffer.from([0x00]), Buffer.from("tail\n")]),
  editedBody = persistedBody;

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
      entries: new Map([
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
  // The real regression: a persisted opaque row whose bytes now read non-textual (NUL) must stay
  // submittable under the policy it was written with, at a text name and at a binary name.
  for (const logical of [textNamed, binaryNamed, rawNamed]) {
    assert.deepEqual(scanFixture(OPAQUE_TEXTUAL_POLICY_ID, logical, editedBody), {
      policyIds: [OPAQUE_TEXTUAL_POLICY_ID],
      blocked: [],
    });
  }
  // A persisted raw row is not rescued by the path judgment: its bytes still decide.
  assert.deepEqual(scanFixture(RAW_ARTIFACT_POLICY_ID, binaryNamed, editedBody), {
    policyIds: [RAW_ARTIFACT_POLICY_ID],
    blocked: [],
  });
  // With no persisted row, NUL bytes at a text name remain a rejected edit, not a new artifact.
  assert.deepEqual(scanFixture(null, textNamed, editedBody), {
    policyIds: [],
    blocked: ["path is not an allowed canonical document"],
  });
  // A brand-new binary artifact at a raw name is still accepted, byte-decided.
  assert.deepEqual(scanFixture(null, "tasks/task_policy/artifacts/screenshots/shot.png", editedBody), {
    policyIds: [RAW_ARTIFACT_POLICY_ID],
    blocked: [],
  });
  // A persisted policy never widens the channel's membership. Outside the artifacts subtree the edge
  // carries `.md`/`.txt` only, so a persisted opaque row at another name is still skipped rather than
  // surfacing as a new blocked row: the live ledger holds 187 such rows (124 `.json`, 11 `.html`, 34
  // `.log`, …) that this channel has never owned. Keeping the rule policy-only would have turned each
  // edit of them into a block.
  assert.deepEqual(scanFixture(OPAQUE_TEXTUAL_POLICY_ID, "context/architecture/notes.json", editedBody), {
    policyIds: [],
    blocked: [],
  });
  // Inside the artifacts subtree the same holds for a text-named row whose bytes no longer decode:
  // a persisted policy keeps an existing row writable, it does not admit a new undecodable `.json`.
  assert.deepEqual(scanFixture(OPAQUE_TEXTUAL_POLICY_ID, "tasks/task_policy/artifacts/data/rows.json", editedBody), {
    policyIds: [],
    blocked: [],
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
