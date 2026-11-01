// harness-test-tier: integration
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalDocumentClaims,
  canonicalDocumentRetirements,
} from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store-factory.ts";
import { openSqliteEventStore } from "../../src/store/sqlite-event-store.ts";
import { assertDocumentAdmission, admissionSettingsBase } from "./document-admission.contract.ts";
import { initRepo } from "./task-event-store.fixtures.ts";

test("SQLite document admission: stateful replacement, preceding heads, rollback and exact replay", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-document-admission-"));
  initRepo(rootDir);
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), admissionSettingsBase);
  const repoId = "document-admission",
    store = makeTaskEventStore({ rootDir, repoId });
  try {
    await assertDocumentAdmission({
      rootDir,
      docStore: store,
      append: store.append,
      snapshot: () => {
        const reader = openSqliteEventStore({ repoId, rootInput: rootDir, readOnly: true });
        try {
          return {
            head: store.currentCut(),
            events: reader.eventRows(),
            outcomes: reader.outcomes(),
            position: reader.replicationPosition(),
            blobs: reader.contentObjectDigests(),
            documents: reader
              .events()
              .flatMap((event) =>
                [...canonicalDocumentClaims(event), ...canonicalDocumentRetirements(event)].map((claim) => [
                  claim.path,
                  reader.documentHead(claim.path),
                ]),
              ),
          };
        } finally {
          reader.close();
        }
      },
    });
  } finally {
    await store.drain();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
