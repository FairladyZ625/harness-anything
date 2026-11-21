// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDeclarationV1, EntityStore } from "@harness-anything/kernel";
import {
  assertBundledAgentLifecycleOpen,
  readAgentDeclaration,
  readAgentDeclarationResolution,
} from "../src/daemon-host/agent-declaration-resolution.ts";

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

test("bundled agent resolution scopes by verticalId for office/collab while preserving software/coding defaults", () => {
  const empty = entityStore(null);
  for (const role of ["coordinator", "contributor", "reviewer", "closeout-reviewer"] as const) {
    const office = readAgentDeclarationResolution({
      rootDir: "/unused",
      agentId: role,
      entityStore: empty,
      verticalId: "office/collab",
    });
    assert.ok(office, role);
    assert.equal(office.layer, "bundled");
    assert.equal(office.declaration.id, role);
    assert.throws(() => assertBundledAgentLifecycleOpen(role, "office/collab"), { code: "agent_system_builtin" });
  }
  assert.equal(
    readAgentDeclarationResolution({ rootDir: "/unused", agentId: "coordinator", entityStore: empty }),
    null,
  );
  assert.doesNotThrow(() => assertBundledAgentLifecycleOpen("coordinator"));

  // Same-name reviewer & closeout-reviewer resolve deterministically per vertical
  const codingReviewer = readAgentDeclaration({
    rootDir: "/unused",
    agentId: "reviewer",
    entityStore: empty,
    verticalId: "software/coding",
  });
  const officeReviewer = readAgentDeclaration({
    rootDir: "/unused",
    agentId: "reviewer",
    entityStore: empty,
    verticalId: "office/collab",
  });
  assert.notEqual(codingReviewer.instructions, officeReviewer.instructions);
  assert.match(officeReviewer.instructions, /deliverable or handoff package/u);

  const codingCloseout = readAgentDeclaration({
    rootDir: "/unused",
    agentId: "closeout-reviewer",
    entityStore: empty,
  });
  const officeCloseout = readAgentDeclaration({
    rootDir: "/unused",
    agentId: "closeout-reviewer",
    entityStore: empty,
    verticalId: "office/collab",
  });
  assert.notEqual(codingCloseout.instructions, officeCloseout.instructions);
  assert.match(officeCloseout.instructions, /collaboration task execution/u);

  // Custom non-builtin vertical falls back to software/coding bundled defaults
  const customFallback = readAgentDeclarationResolution({
    rootDir: "/unused",
    agentId: "closeout-reviewer",
    entityStore: empty,
    verticalId: "science/experiment",
  });
  assert.equal(customFallback?.declaration.instructions, codingCloseout.instructions);
});
