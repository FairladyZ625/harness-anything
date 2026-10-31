// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createEntityStore, makeTaskEventStore } from "@harness-anything/storage";

import {
  assertBundledAgentLifecycleOpen,
  readAgentDeclarationResolution,
} from "../src/agent-declaration-resolution.ts";
import { prepareAgentEntityDelete, prepareAgentEntityInstall } from "../src/agent-entities.ts";
import { readBundledAgentDeclaration } from "@harness-anything/preset";

const codexInstances = [
  { instanceId: "codex-api", kindId: "codex", models: ["deepseek-flash", "gpt-6-luna"], enabled: true },
];

test("ask-agent ships bundled as a read-only codex dispatch on the Flash-class model", () => {
  const declaration = readBundledAgentDeclaration("ask-agent");
  assert.ok(declaration, "ask-agent must ship in the bundled agent layer");
  assert.equal(declaration.permissionMode, "read-only");
  assert.deepEqual(declaration.runtimes, [{ type: "codex", model: "deepseek-flash" }]);
  const resolved = readAgentDeclarationResolution({
    rootDir: "/unused",
    agentId: "ask-agent",
    entityStore: { get: () => null },
  });
  assert.equal(resolved?.layer, "bundled");
});

test("system-bundled agents close their lifecycle: retire and delete are rejected by name", () => {
  for (const bundledId of ["ask-agent", "closeout-reviewer"])
    assert.throws(() => assertBundledAgentLifecycleOpen(bundledId), {
      code: "agent_system_builtin",
      message: new RegExp(`Agent ${bundledId} is a system-bundled agent`, "u"),
    });
  assert.doesNotThrow(() => assertBundledAgentLifecycleOpen("user-installed-agent"));

  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-ask-agent-builtin-"));
  try {
    // Even an installed shadow cannot retire or delete the bundled id: the agent must stay
    // dispatchable forever, while editing an overriding install stays the open path.
    const store = makeTaskEventStore({ repoId: "ask-agent-builtin", rootDir }),
      edited = {
        ...readBundledAgentDeclaration("ask-agent")!,
        runtimes: [{ type: "codex", model: "gpt-6-luna" }],
      },
      revision = store.readHead()?.revision ?? 0,
      bundle = createEntityStore(store).upsert({
        entityKind: "agent",
        entity: edited,
        eventId: `event-agent-ask-agent-${revision + 1}`,
        opId: `op-agent-ask-agent-${revision + 1}`,
        workspaceRevision: revision + 1,
        actor: { principal: { personId: "ask-agent-test" }, executor: null },
        source: "local",
        occurredAt: "2026-10-17T00:00:00.000Z",
      });
    store.append(bundle);
    void store.drain();

    // The model change installs over the bundled layer and wins resolution.
    const changed = prepareAgentEntityInstall({
      rootDir,
      action: { kind: "agent-install", declaration: edited },
      runtimeInstances: codexInstances,
    });
    assert.equal(changed.declaration.runtimes[0]?.model, "gpt-6-luna");
    assert.equal(
      readAgentDeclarationResolution({ rootDir, agentId: "ask-agent" })?.declaration.runtimes[0]?.model,
      "gpt-6-luna",
    );

    assert.throws(
      () =>
        prepareAgentEntityDelete({
          action: { kind: "agent-delete", agentId: "ask-agent", expectedVersion: 1, reason: "replace it" },
          entityStore: { get: () => ({ value: edited, workspaceRevision: 1, documentSha256: "sha" }) } as never,
          projection: {
            readRuntimeDispatches: () => [],
            listEntities: () => [],
            readRelationQuery: () => ({ rows: [] }),
          } as never,
        }),
      { code: "agent_system_builtin" },
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
