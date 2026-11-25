// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDeclarationV1, EntityStore } from "@harness-anything/kernel";
import { listBundledAgentDeclarationIds } from "@harness-anything/preset";
import {
  assertBundledAgentLifecycleOpen,
  readAgentDeclaration,
  readAgentDeclarationResolution,
} from "../src/daemon-host/agent-declaration-resolution.ts";
import {
  prepareAgentEntityDelete,
  prepareAgentEntityInstall,
  prepareAgentEntityRestore,
} from "../src/daemon-host/agent-entities.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

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
    verticalId: "software/coding",
  });
  assert.ok(bundled);
  assert.equal(bundled.layer, "bundled");
  assert.deepEqual(bundled.declaration.runtimes, []);

  const resolved = readAgentDeclarationResolution({
    rootDir: "/unused",
    agentId: "closeout-reviewer",
    entityStore: entityStore(installed),
    verticalId: "software/coding",
  });
  assert.ok(resolved);
  assert.equal(resolved.layer, "installed");
  assert.equal(resolved.declaration.name, "Repository reviewer");
  assert.deepEqual(
    readAgentDeclaration({
      rootDir: "/unused",
      agentId: "closeout-reviewer",
      entityStore: entityStore(installed),
      verticalId: "software/coding",
    }).runtimes,
    [{ type: "codex", model: "review-model" }],
  );
});

test("unknown and invalid Agent ids resolve as absent", () => {
  assert.equal(
    readAgentDeclarationResolution({
      rootDir: "/unused",
      agentId: "not-bundled",
      entityStore: entityStore(null),
      verticalId: "software/coding",
    }),
    null,
  );
  assert.equal(
    readAgentDeclarationResolution({
      rootDir: "/unused",
      agentId: "../invalid",
      entityStore: entityStore(null),
      verticalId: "software/coding",
    }),
    null,
  );
  // Omitting verticalId never silently falls back to software/coding bundled agents.
  assert.equal(
    readAgentDeclarationResolution({
      rootDir: "/unused",
      agentId: "closeout-reviewer",
      entityStore: entityStore(null),
    }),
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
    assert.throws(() => assertBundledAgentLifecycleOpen(role), { code: "agent_system_builtin" });
  }
  assert.equal(
    readAgentDeclarationResolution({
      rootDir: "/unused",
      agentId: "coordinator",
      entityStore: empty,
      verticalId: "software/coding",
    }),
    null,
  );
  // HA09-9: repo-wide retire/delete lifecycle guard protects system-bundled roles across all built-in verticals
  for (const builtinId of ["worker", "reviewer", "closeout-reviewer", "coordinator", "contributor"] as const) {
    assert.throws(() => assertBundledAgentLifecycleOpen(builtinId), { code: "agent_system_builtin" });
  }
  assert.doesNotThrow(() => assertBundledAgentLifecycleOpen("custom-installed-agent"));

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
    verticalId: "software/coding",
  });
  const officeCloseout = readAgentDeclaration({
    rootDir: "/unused",
    agentId: "closeout-reviewer",
    entityStore: empty,
    verticalId: "office/collab",
  });
  assert.notEqual(codingCloseout.instructions, officeCloseout.instructions);
  assert.match(officeCloseout.instructions, /collaboration task execution/u);

  // dec_42EB7B8F636C12381A447E52A3/CH1: unknown/non-builtin verticals never fall back to software/coding agents
  const customUnknown = readAgentDeclarationResolution({
    rootDir: "/unused",
    agentId: "closeout-reviewer",
    entityStore: empty,
    verticalId: "science/experiment",
  });
  assert.equal(customUnknown, null);
  assert.deepEqual(listBundledAgentDeclarationIds("science/experiment", "/unused"), []);
});

test("dec_42EB7B8F636C12381A447E52A3/CH1: local vertical agents resolve directly, shadowed builtin without agents/ falls back to its own builtin agents, and installed overrides win", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-local-office-agents-")),
    pureBuiltinRoot = mkdtempSync(path.join(tmpdir(), "ha-builtin-office-agents-")),
    empty = entityStore(null);
  try {
    const localOfficeDir = path.join(rootDir, "verticals", "legacy-office");
    mkdirSync(localOfficeDir, { recursive: true });
    writeFileSync(path.join(localOfficeDir, "vertical.json"), JSON.stringify({ id: "office/collab" }));

    const builtinOfficeReviewer = readAgentDeclaration({
      rootDir: pureBuiltinRoot,
      agentId: "reviewer",
      entityStore: empty,
      verticalId: "office/collab",
    });

    // Without a local agents/ directory, local shadow of office/collab falls back to builtin office/collab agents (never software/coding)
    assert.equal(
      readAgentDeclaration({ rootDir, agentId: "reviewer", entityStore: empty, verticalId: "office/collab" })
        .instructions,
      builtinOfficeReviewer.instructions,
    );
    assert.equal(
      readAgentDeclarationResolution({
        rootDir,
        agentId: "worker",
        entityStore: empty,
        verticalId: "office/collab",
      }),
      null,
    );
    // dec_4276A0CEACD4D402F122295925/CH1 adds bundled chronicler for living dossiers
    assert.deepEqual(listBundledAgentDeclarationIds("office/collab", rootDir), [
      "chronicler",
      "closeout-reviewer",
      "contributor",
      "coordinator",
      "reviewer",
    ]);
    assert.throws(() => assertBundledAgentLifecycleOpen("worker", rootDir), {
      code: "agent_system_builtin",
    });
    assert.throws(() => assertBundledAgentLifecycleOpen("contributor", rootDir), {
      code: "agent_system_builtin",
    });

    // When local vertical provides agents/*.json, those local roles resolve directly without falling back to software/coding
    const localAgentsDir = path.join(localOfficeDir, "agents");
    mkdirSync(localAgentsDir, { recursive: true });
    writeFileSync(
      path.join(localAgentsDir, "reviewer.json"),
      JSON.stringify({
        schema: "agent-declaration/v1",
        id: "reviewer",
        name: "Local Office Reviewer",
        role: "reviewer",
        instructions: "Apply local office custom checklist.",
        runtimes: [],
        skills: [],
      }),
    );
    writeFileSync(
      path.join(localAgentsDir, "analyst.json"),
      JSON.stringify({
        schema: "agent-declaration/v1",
        id: "analyst",
        name: "Local Office Analyst",
        role: "worker",
        instructions: "Synthesize local office brief.",
        runtimes: [],
        skills: [],
      }),
    );

    const reviewerWithLocalFile = readAgentDeclarationResolution({
      rootDir,
      agentId: "reviewer",
      entityStore: empty,
      verticalId: "office/collab",
    });
    assert.ok(reviewerWithLocalFile);
    assert.equal(reviewerWithLocalFile.layer, "bundled");
    assert.equal(reviewerWithLocalFile.declaration.instructions, "Apply local office custom checklist.");
    const analystResolution = readAgentDeclarationResolution({
      rootDir,
      agentId: "analyst",
      entityStore: empty,
      verticalId: "office/collab",
    });
    assert.ok(analystResolution);
    assert.equal(analystResolution.layer, "bundled");
    assert.equal(analystResolution.declaration.instructions, "Synthesize local office brief.");
    // Local-only agent is not a system-bundled builtin shipped with Harness
    assert.doesNotThrow(() => assertBundledAgentLifecycleOpen("analyst", rootDir));
    assert.equal(
      readAgentDeclarationResolution({
        rootDir,
        agentId: "worker",
        entityStore: empty,
        verticalId: "office/collab",
      }),
      null,
    );
    assert.deepEqual(listBundledAgentDeclarationIds("office/collab", rootDir), ["analyst", "reviewer"]);

    // Pure custom vertical (non-builtin) resolves its own verticals/<dir>/agents/*.json and never falls back to software/coding
    const customAuditDir = path.join(rootDir, "verticals", "finance-audit");
    mkdirSync(path.join(customAuditDir, "agents"), { recursive: true });
    writeFileSync(path.join(customAuditDir, "vertical.json"), JSON.stringify({ id: "finance/audit" }));
    writeFileSync(
      path.join(customAuditDir, "agents", "auditor.json"),
      JSON.stringify({
        schema: "agent-declaration/v1",
        id: "auditor",
        name: "Finance Auditor",
        role: "worker",
        instructions: "Audit financial controls and record findings.",
        runtimes: [],
        skills: [],
      }),
    );
    assert.deepEqual(listBundledAgentDeclarationIds("finance/audit", rootDir), ["auditor"]);
    const auditor = readAgentDeclarationResolution({
      rootDir,
      agentId: "auditor",
      entityStore: empty,
      verticalId: "finance/audit",
    });
    assert.equal(auditor?.declaration.name, "Finance Auditor");
    assert.equal(
      readAgentDeclarationResolution({
        rootDir,
        agentId: "worker",
        entityStore: empty,
        verticalId: "finance/audit",
      }),
      null,
    );

    // Installed canonical Agent entities still shadow the bundled/local-vertical layer cleanly
    const installedReviewer: AgentDeclarationV1 = {
      schema: "agent-declaration/v1",
      id: "reviewer",
      name: "Installed Canonical Reviewer",
      role: "reviewer",
      instructions: "Canonical installed reviewer instructions.",
      runtimes: [{ type: "codex", model: "review-model" }],
    };
    const installedResolution = readAgentDeclarationResolution({
      rootDir,
      agentId: "reviewer",
      entityStore: entityStore(installedReviewer),
      verticalId: "office/collab",
    });
    assert.ok(installedResolution);
    assert.equal(installedResolution.layer, "installed");
    assert.equal(installedResolution.declaration.instructions, installedReviewer.instructions);

    // Pure built-in office/collab (no local vertical override) continues selecting bundled office agents
    const pureOfficeReviewer = readAgentDeclarationResolution({
      rootDir: pureBuiltinRoot,
      agentId: "reviewer",
      entityStore: empty,
      verticalId: "office/collab",
    });
    assert.ok(pureOfficeReviewer);
    assert.equal(pureOfficeReviewer.layer, "bundled");
    assert.match(pureOfficeReviewer.declaration.instructions, /deliverable or handoff package/u);
    // dec_4276A0CEACD4D402F122295925/CH1 adds bundled chronicler for living dossiers
    assert.deepEqual(listBundledAgentDeclarationIds("office/collab", pureBuiltinRoot), [
      "chronicler",
      "closeout-reviewer",
      "contributor",
      "coordinator",
      "reviewer",
    ]);
  } finally {
    removeTempRepository(rootDir);
    removeTempRepository(pureBuiltinRoot);
  }
});

test("HA09-10: already-retired custom agent colliding with a newly shipped bundled id can be deleted or reinstalled while active overrides and ordinary retired agents stay guarded", () => {
  const retiredCollision = {
    schema: "agent-declaration/v1" as const,
    id: "contributor",
    name: "Pre-upgrade custom contributor",
    role: "worker" as const,
    instructions: "Legacy custom contributor instructions.",
    runtimes: [{ type: "codex" as const, model: "legacy-model" }],
    lifecycleState: "retired" as const,
    retirement: { retiredAt: "2026-10-01T00:00:00.000Z", reason: "Retired before office/collab shipped" },
  };
  const activeCollision: AgentDeclarationV1 = {
    schema: "agent-declaration/v1",
    id: "contributor",
    name: "Active contributor override",
    role: "worker",
    instructions: "Active override instructions.",
    runtimes: [{ type: "codex", model: "active-model" }],
  };
  const retiredOrdinary = {
    schema: "agent-declaration/v1" as const,
    id: "retired-custom-only",
    name: "Retired ordinary custom agent",
    role: "worker" as const,
    instructions: "Retired ordinary custom instructions.",
    runtimes: [{ type: "codex" as const, model: "legacy-model" }],
    lifecycleState: "retired" as const,
    retirement: { retiredAt: "2026-10-01T00:00:00.000Z", reason: "Retired ordinary custom agent" },
  };
  const makeStore = (record: Record<string, unknown> | null): EntityStore => ({
    upsert: () => {
      throw new Error("unused");
    },
    get: <T>() =>
      record
        ? ({
            kind: "agent",
            id: String(record.id),
            value: record as T,
            documentPath: `harness/agents/${String(record.id)}.json`,
            documentSha256: "sha-retired-collision",
            workspaceRevision: 10,
          } as const)
        : null,
    list: () => [],
  });
  const emptyProjection = {
    countRuntimeDispatchesByAgent: () => 0,
    listEntities: () => [],
    readRelationQuery: () => ({ rows: [] }),
  } as never;

  // 1. Deleting an already-retired custom collision passes the builtin guard and prepares deletion.
  const preparedDelete = prepareAgentEntityDelete({
    rootDir: "/unused",
    action: {
      kind: "agent-delete",
      agentId: "contributor",
      expectedVersion: 10,
      reason: "Clear retired pre-upgrade collision so bundled office/collab contributor is usable",
    },
    entityStore: makeStore(retiredCollision),
    projection: emptyProjection,
  });
  assert.deepEqual(preparedDelete, { entityId: "contributor", baseBlobSha256: "sha-retired-collision" });

  // 2. Reinstalling/updating an already-retired custom collision prepares an active overriding declaration.
  const preparedReinstall = prepareAgentEntityInstall({
    rootDir: "/unused",
    action: {
      kind: "agent-install",
      declaration: activeCollision,
      expectedVersion: 10,
    },
    entityStore: makeStore(retiredCollision),
  });
  assert.equal(preparedReinstall.declaration.id, "contributor");
  assert.equal(preparedReinstall.declaration.name, "Active contributor override");

  // 3. Partial agentId update on an already-retired custom collision strips retired metadata and succeeds.
  const preparedPatch = prepareAgentEntityInstall({
    rootDir: "/unused",
    action: {
      kind: "agent-install",
      agentId: "contributor",
      mcpPolicy: "disabled",
      expectedVersion: 10,
    },
    entityStore: makeStore(retiredCollision),
  });
  assert.equal(preparedPatch.declaration.mcpPolicy, "disabled");
  assert.equal("lifecycleState" in preparedPatch.declaration, false);

  // 4. Active override of a bundled id is STILL protected from deletion (HA09-9 preserved).
  assert.throws(
    () =>
      prepareAgentEntityDelete({
        rootDir: "/unused",
        action: { kind: "agent-delete", agentId: "contributor", expectedVersion: 10, reason: "attempt delete" },
        entityStore: makeStore(activeCollision),
        projection: emptyProjection,
      }),
    { code: "agent_system_builtin" },
  );

  // 5. Ordinary non-bundled retired custom agent is STILL blocked from reinstallation.
  assert.throws(
    () =>
      prepareAgentEntityInstall({
        rootDir: "/unused",
        action: {
          kind: "agent-install",
          declaration: {
            schema: "agent-declaration/v1",
            id: "retired-custom-only",
            name: "Revive attempt",
            role: "worker",
            instructions: "Must remain blocked.",
            runtimes: [{ type: "codex", model: "active-model" }],
          },
          expectedVersion: 10,
        },
        entityStore: makeStore(retiredOrdinary),
      }),
    { code: "agent_retired" },
  );

  // 6. Explicit reactivate: true on an ordinary retired custom agent prepares reactivation metadata.
  const preparedCustomReactivate = prepareAgentEntityInstall({
    rootDir: "/unused",
    action: {
      kind: "agent-install",
      declaration: {
        schema: "agent-declaration/v1",
        id: "retired-custom-only",
        name: "Revived Custom",
        role: "worker",
        instructions: "Explicitly reactivated custom agent.",
        runtimes: [{ type: "codex", model: "active-model" }],
      },
      reactivate: true,
      reason: "Operator requested reinstall reactivation.",
      expectedVersion: 10,
    },
    entityStore: makeStore(retiredOrdinary),
  });
  assert.deepEqual(preparedCustomReactivate.reactivateRetired, {
    priorVersion: 10,
    reason: "Operator requested reinstall reactivation.",
  });

  // 7. Reactivate-only install by agentId strips retirement metadata and marks reactivateOnly.
  const preparedIdOnly = prepareAgentEntityInstall({
    rootDir: "/unused",
    action: {
      kind: "agent-install",
      agentId: "retired-custom-only",
      reactivate: true,
      reason: "Restore without overrides.",
      expectedVersion: 10,
    },
    entityStore: makeStore(retiredOrdinary),
  });
  assert.equal(preparedIdOnly.reactivateOnly, true);
  assert.deepEqual(preparedIdOnly.reactivateRetired, {
    priorVersion: 10,
    reason: "Restore without overrides.",
  });

  // 8. Retired shared agent cannot bypass retirement by switching to local scope.
  assert.throws(
    () =>
      prepareAgentEntityInstall({
        rootDir: "/unused",
        action: {
          kind: "agent-install",
          agentId: "retired-custom-only",
          scope: "local",
          reactivate: true,
          expectedVersion: 10,
        },
        entityStore: makeStore(retiredOrdinary),
      }),
    { code: "agent_retired" },
  );

  // 9. prepareAgentEntityRestore blocks divergent local/shared scope conflicts.
  assert.throws(
    () =>
      prepareAgentEntityRestore({
        action: { kind: "agent-restore", agentId: "retired-custom-only", reason: "Restore" },
        replayed: null,
        projection: {
          getEntity: () => ({ value: retiredOrdinary }) as never,
        },
        localAgent: () => ({
          schema: "local-agent-record/v1",
          id: "retired-custom-only",
          revision: 1,
          declaration: {
            schema: "agent-declaration/v1",
            id: "retired-custom-only",
            name: "Divergent local copy",
            instructions: "Different body.",
            runtimes: [{ type: "codex" }],
            scope: "local",
          },
        }),
      }),
    { code: "agent_scope_conflict" },
  );
});
