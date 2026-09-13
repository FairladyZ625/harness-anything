// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDeclarationV1, EntityStore } from "../../kernel/src/index.ts";
import { readAgentDeclaration, readAgentDeclarationResolution } from "../src/agent-declaration-resolution.ts";

const installed: AgentDeclarationV1 = {
  schema: "agent-declaration/v1",
  id: "closeout-reviewer",
  name: "Repository reviewer",
  instructions: "Review precisely.",
  runtime_type: "codex",
  model: "review-model",
  role: "worker",
};

function entityStore(declaration: AgentDeclarationV1 | null): EntityStore {
  return {
    upsert: () => {
      throw new Error("unused");
    },
    get: <T>() =>
      declaration
        ? ({
            kind: "agent",
            id: declaration.id,
            value: declaration as T,
            documentPath: "harness/agents/closeout-reviewer.json",
            documentSha256: "fixture",
            workspaceRevision: 1,
          } as const)
        : null,
    list: () => [],
  };
}

test("installed Agent declarations shadow the bundled product declaration", () => {
  const bundled = readAgentDeclarationResolution({
    rootDir: "/unused",
    agentId: "closeout-reviewer",
    entityStore: entityStore(null),
  });
  assert.ok(bundled);
  assert.equal(bundled.layer, "bundled");
  assert.equal(bundled.declaration.model, undefined);

  const resolved = readAgentDeclarationResolution({
    rootDir: "/unused",
    agentId: "closeout-reviewer",
    entityStore: entityStore(installed),
  });
  assert.ok(resolved);
  assert.equal(resolved.layer, "installed");
  assert.equal(resolved.declaration.name, "Repository reviewer");
  assert.equal(
    readAgentDeclaration({ rootDir: "/unused", agentId: "closeout-reviewer", entityStore: entityStore(installed) })
      .model,
    "review-model",
  );
});

test("unknown and invalid Agent ids resolve as absent", () => {
  assert.equal(
    readAgentDeclarationResolution({ rootDir: "/unused", agentId: "not-bundled", entityStore: entityStore(null) }),
    null,
  );
  assert.equal(
    readAgentDeclarationResolution({ rootDir: "/unused", agentId: "../invalid", entityStore: entityStore(null) }),
    null,
  );
});
