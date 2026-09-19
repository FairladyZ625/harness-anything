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
  runtimes: [{ type: "codex", model: "review-model" }],
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
  assert.deepEqual(bundled.declaration.runtimes, []);

  const resolved = readAgentDeclarationResolution({
    rootDir: "/unused",
    agentId: "closeout-reviewer",
    entityStore: entityStore(installed),
  });
  assert.ok(resolved);
  assert.equal(resolved.layer, "installed");
  assert.equal(resolved.declaration.name, "Repository reviewer");
  assert.deepEqual(
    readAgentDeclaration({ rootDir: "/unused", agentId: "closeout-reviewer", entityStore: entityStore(installed) })
      .runtimes,
    [{ type: "codex", model: "review-model" }],
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

test("an installed declaration the current schema rejects resolves as an actionable reinstall error", () => {
  const invalidStore = {
    upsert: () => {
      throw new Error("unused");
    },
    // The entity store throws exactly this for a stored declaration the schema rejects.
    get: () => {
      throw Object.assign(
        new Error(
          'agent declaration is missing required field "runtimes".; agent declaration field "runtime_type" is unknown; remove it.',
        ),
        { code: "invalid_entity_contract" },
      );
    },
    list: () => [],
  } as unknown as EntityStore;
  assert.throws(
    () => readAgentDeclaration({ rootDir: "/unused", agentId: "legacy-worker", entityStore: invalidStore }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "agent_declaration_invalid");
      assert.match(String((error as Error).message), /ha agent install --source harness\/agents\/legacy-worker\.json/u);
      return true;
    },
  );
  assert.throws(
    () => readAgentDeclarationResolution({ rootDir: "/unused", agentId: "legacy-worker", entityStore: invalidStore }),
    (error: unknown) => (error as { code?: string }).code === "agent_declaration_invalid",
  );
});
