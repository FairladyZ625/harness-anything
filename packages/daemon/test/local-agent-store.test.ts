// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  readLocalAgentDeclarations,
  readLocalAgentRecord,
  removeLocalAgentDeclaration,
  writeLocalAgentDeclaration,
} from "../src/daemon-host/local-agent-store.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

test("local Agent declarations persist under a repository-specific daemon user root", () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-local-agents-")),
    declaration = {
      schema: "agent-declaration/v1" as const,
      id: "private-helper",
      name: "Private helper",
      instructions: "Run local experiments.",
      runtimes: [],
      scope: "local" as const,
    };
  try {
    writeLocalAgentDeclaration(userRoot, "repo_123", declaration);
    assert.deepEqual(readLocalAgentDeclarations(userRoot, "repo_123"), [declaration]);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(userRoot, "local-agents", "repo_123", "private-helper.json"), "utf8")),
      { schema: "local-agent-record/v1", id: declaration.id, revision: 1, declaration },
    );
    assert.throws(() => writeLocalAgentDeclaration(userRoot, "repo_123", declaration, 0), {
      code: "revision_conflict",
    });
    assert.equal(writeLocalAgentDeclaration(userRoot, "repo_123", declaration, 1), 2);
    const intent = {
      direction: "share" as const,
      operationId: "op-share-1",
      sourceRevision: 2,
      targetScope: "shared" as const,
      declarationSha256: `sha256:${"a".repeat(64)}`,
    };
    assert.equal(
      writeLocalAgentDeclaration(userRoot, "repo_123", declaration, {
        expectedVersion: 2,
        preserveRevision: true,
        pendingTransfer: intent,
      }),
      2,
    );
    assert.deepEqual(readLocalAgentRecord(userRoot, "repo_123", declaration.id)?.pendingTransfer, intent);
    assert.throws(() => removeLocalAgentDeclaration(userRoot, "repo_123", declaration.id, { expectedVersion: 99 }), {
      code: "revision_conflict",
    });
    assert.deepEqual(readLocalAgentDeclarations(userRoot, "repo_other"), []);
    removeLocalAgentDeclaration(userRoot, "repo_123", declaration.id, { expectedVersion: 2 });
    assert.deepEqual(readLocalAgentDeclarations(userRoot, "repo_123"), []);
  } finally {
    removeTempRepository(userRoot);
  }
});

test("local Agent storage rejects project-shared declarations", () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-local-agents-"));
  try {
    assert.throws(() =>
      writeLocalAgentDeclaration(userRoot, "repo_123", {
        schema: "agent-declaration/v1",
        id: "team-helper",
        name: "Team helper",
        instructions: "Shared work.",
        runtimes: [],
        scope: "shared",
      }),
    );
  } finally {
    removeTempRepository(userRoot);
  }
});
