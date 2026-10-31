// harness-test-tier: integration
// A persisted doc claim is only evidence when the bytes are the real ones.
// `fixtures/historical-doc-claims/` freezes a cut of the canonical ledger — revisions 134383 and
// 134508, copied byte-for-byte from the live `event.event_json` column, plus every content object
// those events claim. Revision 134508 wrote `.../ceo-format-preview/test.pdf` under
// `opaque-textual-whole-file/v1`, which is precisely the historical shape today's byte classifier
// answers `raw-artifact` for. The checks below run the production reducer over those bytes: the
// persisted row must still read back under the policy it was written under, and its bytes must stay
// writable under that same policy. The companion `projection-row.json` is the row the live projection
// cache served for it, captured before this change.
//
// A complete cold rebuild of *this cut* is not attempted here: the cut begins at revision 134383 and
// the production rebuild resumes deferred events inside a `catchUpLimit` window from the watermark, so
// a history whose first revision is far beyond that window has no continuous prefix to replay. The
// cold-rebuild proof runs against a byte-for-byte copy of the whole live ledger (contiguous from
// revision 1); its raw output is recorded in the task package's `artifacts/evidence/`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import type { EventStreamPort } from "@harness-anything/kernel/internal/ports/task-projection-source.ts";
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync-types.ts";
import { docSyncWritePlan } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { decideDocWrite } from "@harness-anything/kernel/internal/domain/doc-sync-writer.ts";
import { parseDocWriteIntent } from "@harness-anything/kernel/internal/domain/doc-sync-codec.ts";
import {
  classifyDocCandidate,
  OPAQUE_TEXTUAL_POLICY_ID,
} from "@harness-anything/kernel/internal/domain/artifact-text-classification.ts";
import { sha256Bytes } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";

const fixtureRoot = path.resolve(import.meta.dirname, "../../../kernel/fixtures/historical-doc-claims"),
  pdfPath =
    "tasks/task_b13be1ea63c151501a626eaa24-document-viewer-scroll-and-formats/artifacts/ceo-format-preview/test.pdf",
  pdfSha256 = "a581e4b6ba94d86374be3e295be7b718e732d958575dd4264b9378af7f1cd0a1";

type FrozenEvent = Readonly<{ revision: number; opId: string; eventId: string; path: string; ledgerDigest: string }>;

const manifest = JSON.parse(readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8")) as readonly FrozenEvent[],
  frozenRow = JSON.parse(readFileSync(path.join(fixtureRoot, "projection-row.json"), "utf8")) as {
    readonly path: string;
    readonly row: {
      readonly blobSha256: string;
      readonly body: string;
      readonly size: number;
      readonly mediaType: string;
      readonly policyId: string;
      readonly workspaceRevision: number;
    };
  };

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The fixture's object store: the same content lookup the SQLite ledger performs, over copied bytes. */
function readContentBlob(sha: string): Uint8Array | null {
  const stem = path.join(fixtureRoot, "objects/sha256", sha.slice(0, 2), sha.slice(2));
  try {
    return readFileSync(stem);
  } catch {
    try {
      return Buffer.from(readFileSync(`${stem}.base64`, "utf8").trim(), "base64");
    } catch {
      return null;
    }
  }
}

function frozenEvents(): readonly PersistedCanonicalEventV1[] {
  return manifest.map((entry) => {
    const body = readFileSync(entry.path, "utf8");
    // Each file is the ledger's own event_json value, so its digest is the digest the ledger recorded.
    assert.equal(`sha256:${digest(Buffer.from(body))}`, entry.ledgerDigest, `${entry.revision}: frozen bytes changed`);
    return JSON.parse(body) as PersistedCanonicalEventV1;
  });
}

/**
 * The cut as an event stream. It deliberately serves no `readBatch`: a projection opened on it must
 * read the persisted claim the ledger already wrote, not start from a stream scan.
 */
function cutStore(events: readonly PersistedCanonicalEventV1[]): EventStreamPort {
  const head = events.at(-1)!,
    headDigest = manifest.find((entry) => entry.revision === head.workspaceRevision)!
      .ledgerDigest as `sha256:${string}`;
  return {
    readHead: () => ({ revision: head.workspaceRevision, opId: head.opId, eventDigest: headDigest }),
    readBatch: () => {
      throw new Error("this cut is read through its persisted claims, not a stream scan");
    },
    readContentBlob,
  };
}

function claimsOf(event: PersistedCanonicalEventV1): readonly {
  readonly path: string;
  readonly candidate: { readonly sha256: string; readonly size: number; readonly mediaType: string };
  readonly policyId: string;
}[] {
  return (
    event as unknown as {
      readonly payload: {
        readonly changes: readonly {
          readonly path: string;
          readonly candidate: { readonly sha256: string; readonly size: number; readonly mediaType: string };
          readonly policyId: string;
        }[];
      };
    }
  ).payload.changes;
}

test("the frozen cut is the canonical ledger's own bytes, and its PDF claim is still opaque", () => {
  const events = frozenEvents(),
    pdf = claimsOf(events.at(-1)!).find((change) => change.path === pdfPath);
  assert.deepEqual(
    events.map((event) => [event.workspaceRevision, event.opId]),
    manifest.map((entry) => [entry.revision, entry.opId]),
  );
  assert.ok(pdf, "the frozen cut must carry the PDF claim");
  assert.deepEqual(
    [pdf.policyId, pdf.candidate.mediaType, pdf.candidate.sha256, pdf.candidate.size],
    [OPAQUE_TEXTUAL_POLICY_ID, "text/x-harness-opaque", pdfSha256, 873],
  );
  // The tension this fixture pins: today's byte judgment calls this name/byte pair raw, while the row
  // the ledger wrote and still serves is opaque text. Both statements are true at once; nothing about
  // the persisted claim changed, so no field needs rewriting.
  assert.equal(classifyDocCandidate(pdfPath, readContentBlob(pdfSha256))?.kind, "raw-artifact");
  assert.deepEqual(
    [frozenRow.row.policyId, frozenRow.row.mediaType, frozenRow.row.size, frozenRow.row.blobSha256],
    [OPAQUE_TEXTUAL_POLICY_ID, "text/x-harness-opaque", 873, pdfSha256],
  );
  assert.equal(digest(Buffer.from(frozenRow.row.body)), frozenRow.row.blobSha256);
});

test("the real cut's persisted PDF claim reads back unchanged through the production reducer", () => {
  const events = frozenEvents(),
    rootDir = mkdtempSync(path.join(tmpdir(), "historical-doc-direct-"));
  try {
    const projection = makeTaskProjection({ rootDir, eventStore: cutStore(events) });
    try {
      for (const event of events) projection.apply(event, docSyncWritePlan(event));
      const read = projection.readDocument(pdfPath).document;
      assert.ok(read, "the persisted PDF row must be readable");
      assert.deepEqual(
        [read.policyId, read.mediaType, read.size, read.blobSha256],
        [OPAQUE_TEXTUAL_POLICY_ID, "text/x-harness-opaque", 873, pdfSha256],
      );
      assert.equal(digest(Buffer.from(read.body)), read.blobSha256);
      assert.deepEqual(
        [read.policyId, read.mediaType, read.size, read.blobSha256],
        [frozenRow.row.policyId, frozenRow.row.mediaType, frozenRow.row.size, frozenRow.row.blobSha256],
        "the replayed row must equal the row the pre-change cache served",
      );
    } finally {
      projection.close();
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("an edit of the real persisted PDF claim keeps its written policy and stays writable", () => {
  const events = frozenEvents(),
    claimed = claimsOf(events.at(-1)!).find((change) => change.path === pdfPath)!,
    original = readContentBlob(claimed.candidate.sha256)!,
    edited = Buffer.concat([Buffer.from(original), Buffer.from("% reviewed\n")]),
    editedSha = sha256Bytes(edited),
    cut = { repoId: "canonical", revision: 134508, headDigest: `sha256:${"0".repeat(64)}` } as const,
    decision = decideDocWrite({
      intent: parseDocWriteIntent(
        {
          schema: "doc-write-intent/v1",
          executionId: null,
          baseLedgerSha: cut,
          changes: [
            {
              path: pdfPath,
              baseBlobSha256: claimed.candidate.sha256,
              policyId: OPAQUE_TEXTUAL_POLICY_ID,
              candidate: {
                ref: `doc-sync-claims/${editedSha}`,
                sha256: editedSha,
                size: edited.byteLength,
                mediaType: "text/x-harness-opaque",
              },
            },
          ],
        },
        "canonical",
      ),
      opId: "op_historical_claim_edit",
      eventId: "event-historical-claim-edit",
      workspaceRevision: 134509,
      actor: { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } },
      source: "local",
      occurredAt: "2026-10-22T00:00:00.000Z",
      currentLedgerSha: cut,
      lease: null,
      authorizationDecision: null,
      documents: [
        {
          path: pdfPath,
          blobSha256: claimed.candidate.sha256,
          size: claimed.candidate.size,
          mediaType: claimed.candidate.mediaType,
          policyId: claimed.policyId,
          body: Buffer.from(original).toString("utf8"),
          workspaceRevision: 134508,
        },
      ],
      claims: [edited],
    });
  assert.equal(decision.accepted, true, JSON.stringify(decision));
  if (!decision.accepted) return;
  const written = decision.event.payload.changes[0]!;
  // The old row is not re-stamped: one entry writes it under the policy it already has.
  assert.deepEqual(
    [written.policyId, written.candidate.mediaType, written.candidate.sha256],
    [OPAQUE_TEXTUAL_POLICY_ID, "text/x-harness-opaque", editedSha],
  );
  assert.equal("policyUpgrade" in written, false);
});
