// harness-test-tier: integration
import { testWriteAttribution } from "../test-attribution.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  projectDeclaredEntities,
  readDeclaredProjectionRows
} from "../../src/projection/entity-declaration-projection.ts";
import {
  readSessionEntityDocument,
  sessionEntityDeclaration,
  writeSessionEntity
} from "../../src/entity/session.ts";
import { getEntityRegistration } from "../../src/entity/registry.ts";
import { writeContentAddressedBlob } from "../../src/store/content-addressed-blob-store.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/write-journal-coordinator.ts";
import { withTempStore } from "./helpers.ts";

test("session manifests coordinate compact state, immutable transcript bodies, and rebuildable projections", () => {
  withTempStore((rootDir) => {
    const body = "# Session ses_1\n\n### User\n\nHello.\n";
    const bodyRef = {
      store: "authored-cas/v1" as const,
      ...writeContentAddressedBlob(rootDir, body, "text/markdown; charset=utf-8")
    };
    const manifest = {
      schema: "session-entity/v1" as const,
      sessionId: "ses_1",
      lifecycle: "sealed" as const,
      archiveStatus: "complete" as const,
      runtime: "codex" as const,
      source: "runtime" as const,
      detectedAt: "2026-07-11T01:00:00.000Z",
      exportedAt: "2026-07-11T01:05:00.000Z",
      bodyRef,
      snapshot: {
        capturedAt: "2026-07-11T01:05:00.000Z",
        completeness: "complete" as const,
        captureRange: {
          messageCount: 1,
          firstMessageAt: "2026-07-11T01:01:00.000Z",
          lastMessageAt: "2026-07-11T01:01:00.000Z"
        },
        privacyScan: {
          scannerVersion: "publish-redaction/v1",
          passed: true,
          findings: []
        }
      }
    };
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(),
      rootDir,
    });

    Effect.runSync(writeSessionEntity(coordinator, rootDir, manifest));
    assert.equal(getEntityRegistration("session"), sessionEntityDeclaration);

    const stored = readFileSync(path.join(rootDir, "harness/sessions/ses_1.md"), "utf8");
    assert.equal(stored.includes("Hello."), false);
    assert.deepEqual(readSessionEntityDocument(rootDir, "ses_1"), {
      format: "manifest",
      manifest
    });
    assert.equal(readFileSync(path.join(rootDir, bodyRef.ref), "utf8"), body);

    const projectionPath = path.join(rootDir, ".harness/cache/session-projection.sqlite");
    writeFileSync(path.join(rootDir, "harness/sessions/README.md"), "# Sessions\n");
    const projected = projectDeclaredEntities(rootDir, sessionEntityDeclaration, projectionPath);
    assert.deepEqual(projected.rows, [{
      session_id: "ses_1",
      lifecycle: "sealed",
      archive_status: "complete",
      runtime: "codex",
      exported_at: "2026-07-11T01:05:00.000Z",
      body_sha256: bodyRef.sha256,
      body_ref_json: JSON.stringify(manifest.bodyRef),
      snapshot_json: JSON.stringify(manifest.snapshot)
    }]);
    assert.deepEqual(readDeclaredProjectionRows(projectionPath, sessionEntityDeclaration), projected.rows);
  });
});

test("session reader rejects legacy transcript markdown after cutover", () => {
  withTempStore((rootDir) => {
    const legacyBody = [
      "---",
      "schema: provenance-session/v1",
      "sessionId: legacy-session",
      "runtime: claude-code",
      "source: runtime",
      "detectedAt: 2026-07-10T01:00:00.000Z",
      "exportedAt: 2026-07-10T01:05:00.000Z",
      "---",
      "",
      "# Session legacy-session",
      "",
      "### User",
      "",
      "Legacy transcript.",
      ""
    ].join("\n");
    const sessionPath = path.join(rootDir, "harness/sessions/legacy-session.md");
    mkdirSync(path.dirname(sessionPath), { recursive: true });
    writeFileSync(sessionPath, legacyBody, "utf8");

    assert.throws(() => readSessionEntityDocument(rootDir, "legacy-session"));
    assert.equal(readFileSync(sessionPath, "utf8"), legacyBody);
    const projectionPath = path.join(rootDir, ".harness/cache/legacy-session-projection.sqlite");
    assert.deepEqual(projectDeclaredEntities(rootDir, sessionEntityDeclaration, projectionPath).rows, []);
  });
});

test("session CAS install is recoverable only after its journal payload is durable", () => {
  withTempStore((rootDir) => {
    const blobBody = "killpoint body: CAS must not exist before journal recovery\n";
    const sha256 = sha256Text(blobBody);
    const bodyRef = {
      ref: `harness/objects/sha256/${sha256.slice(0, 2)}/${sha256.slice(2)}`,
      sha256,
      size: Buffer.byteLength(blobBody, "utf8"),
      mediaType: "text/markdown; charset=utf-8"
    };
    const manifest = {
      schema: "session-entity/v1",
      sessionId: "ses_journal_killpoint",
      lifecycle: "sealed",
      archiveStatus: "complete",
      runtime: "codex",
      source: "runtime",
      detectedAt: "2026-07-17T00:00:00.000Z",
      exportedAt: "2026-07-17T00:01:00.000Z",
      bodyRef: { store: "authored-cas/v1", ...bodyRef },
      snapshot: {
        capturedAt: "2026-07-17T00:01:00.000Z",
        completeness: "complete",
        captureRange: { messageCount: 1, firstMessageAt: "2026-07-17T00:00:00.000Z", lastMessageAt: "2026-07-17T00:00:00.000Z" },
        privacyScan: { scannerVersion: "publish-redaction/v1", passed: true, findings: [] }
      }
    } as const;
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    Effect.runSync(coordinator.enqueue({
      opId: "op-session-journal-killpoint",
      entityId: "entity/session/ses_journal_killpoint",
      kind: "doc_write",
      payload: {
        entityDocument: {
          declaration: {
            kind: sessionEntityDeclaration.kind,
            storageForm: sessionEntityDeclaration.storageForm,
            rootResolver: sessionEntityDeclaration.rootResolver
          },
          identity: { sessionId: manifest.sessionId },
          body: sessionEntityDeclaration.documentCodec.encode(manifest),
          blobRef: bodyRef,
          blobBody
        }
      }
    }));

    // Simulated process death after enqueue/journal fsync and before apply.
    assert.equal(existsSync(path.join(rootDir, bodyRef.ref)), false);
    Effect.runSync(makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir }).recover);
    assert.equal(readFileSync(path.join(rootDir, bodyRef.ref), "utf8"), blobBody);
    assert.deepEqual(readSessionEntityDocument(rootDir, manifest.sessionId).manifest, manifest);
  });
});
