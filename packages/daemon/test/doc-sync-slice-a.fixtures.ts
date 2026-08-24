import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  MIGRATION_DOCUMENT_POLICY_ID,
  MIGRATION_IMPORT_SOURCE,
  migrationImportWritePlan,
  sha256Text,
  type CanonicalWriteBundle,
  type MigrationImportEventV1,
} from "../../kernel/src/index.ts";

export const actor = {
  principal: { personId: "person-owner" },
  executor: { kind: "agent", id: "codex" },
} as const;
export const opaqueTextualMediaType = "application/json";

export function standardMigration(
  revision: number,
  target: string,
  body: string,
): CanonicalWriteBundle {
  const opId = `op-migration-${revision}`;
  const migration: MigrationImportEventV1 = {
    schema: "migration-import-event/v1",
    eventId: `event-${opId}`,
    workspaceRevision: revision,
    opId,
    type: "entity_migrated",
    actor,
    source: MIGRATION_IMPORT_SOURCE,
    occurredAt: "2026-08-11T00:00:00.000Z",
    payload: {
      migratedFrom: target,
      generation: "v0",
      entity: {
        kind: "repo-document",
        nodeKind: "file",
        documentClaim: {
          path: target,
          sha256: sha256Text(body),
          size: Buffer.byteLength(body),
          mediaType: "text/markdown",
          policyId: MIGRATION_DOCUMENT_POLICY_ID,
        },
        referencedContentClaims: [],
      },
    },
  };
  return {
    event: migration,
    plan: migrationImportWritePlan(migration),
    blobs: [
      {
        sha256: sha256Text(body),
        size: Buffer.byteLength(body),
        mediaType: "text/markdown",
        body,
      },
    ],
  };
}
export function rows(
  evidence: string | undefined,
): readonly { readonly path: string; readonly state: string }[] {
  assert.match(evidence ?? "", /^doc-scan:/u);
  return (
    JSON.parse((evidence ?? "").slice("doc-scan:".length)) as {
      rows: readonly { path: string; state: string }[];
    }
  ).rows;
}
export function blockedReason(evidence: string | undefined): string {
  assert.match(evidence ?? "", /^doc-scan:/u);
  return (
    (
      JSON.parse((evidence ?? "").slice("doc-scan:".length)) as {
        rows: readonly { reason: string | null }[];
      }
    ).rows[0]?.reason ?? ""
  );
}
export function materializeReport(evidence: string | undefined): {
  readonly changed: readonly string[];
  readonly conflicts: readonly string[];
} {
  assert.match(evidence ?? "", /^doc-materialize:/u);
  return JSON.parse((evidence ?? "").slice("doc-materialize:".length)) as {
    changed: readonly string[];
    conflicts: readonly string[];
  };
}
export function write(rootDir: string, target: string, body: string): void {
  const file = path.join(rootDir, "harness", target);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}
export function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Doc A Test");
  git(rootDir, "config", "user.email", "doc-a@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
}
export function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
  }).trim();
}
