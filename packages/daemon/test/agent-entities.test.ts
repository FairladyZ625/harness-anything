// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createEntityStore, makeTaskEventStore, makeTaskProjection } from "../../kernel/src/index.ts";
import {
  prepareAgentEntityInstall,
  readAgentEntityGuiProjection,
  resolveSquadDispatch,
  runAgentEntityAction,
} from "../src/agent-entities.ts";
import { discoverAgentSkills, resolveAgentSkills } from "../src/agent-skills.ts";
import { validateAgentDeclarationV1, validateSquadDeclarationV1 } from "../../kernel/src/index.ts";

const agent = {
    schema: "agent-declaration/v1",
    id: "terra",
    name: "Terra",
    instructions: "Review precisely.",
    runtime_type: "codex",
    model: "gpt-5.6-terra",
    skills: [{ id: "review", path: "skills/review" }],
    prompts: ["prompt://review"],
    preset: "standard-task",
  },
  squad = {
    schema: "squad-declaration/v1",
    id: "core-squad",
    name: "Core Squad",
    leader: "terra",
    workers: ["terra"],
    leaderTurnBudget: 8,
    roster: "# Core Squad\n\nTerra leads review.",
  };

test("Agent and Squad entities prepare, list, inspect, and replace declarations in the authored store", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-entities-")),
    source = path.join(rootDir, "source");
  try {
    writeEntity(source, "terra", "agent", agent);
    writeEntity(source, "core-squad", "squad", squad);
    assert.equal(
      (run({ rootDir, kind: "agent-validate", packageSource: path.join(source, "terra") }) as { valid: boolean }).valid,
      true,
    );
    assert.equal(
      (run({ rootDir, kind: "squad-validate", packageSource: path.join(source, "core-squad") }) as { valid: boolean })
        .valid,
      true,
    );
    await install({ rootDir, kind: "agent-install", packageSource: path.join(source, "terra") });
    await install({ rootDir, kind: "squad-install", packageSource: path.join(source, "core-squad") });
    assert.equal(
      readFileSync(path.join(rootDir, "harness/agents/terra.json"), "utf8"),
      `${JSON.stringify(agent, null, 2)}\n`,
    );
    assert.deepEqual(
      (
        run({ rootDir, kind: "agent-list" }) as {
          agents: Array<{ id: string; runtime_type: string; layer: string; validity: string }>;
        }
      ).agents.map(({ id, runtime_type, layer, validity }) => ({ id, runtime_type, layer, validity })),
      [{ id: "terra", runtime_type: "codex", layer: "user", validity: "valid" }],
    );
    assert.deepEqual(
      (
        run({ rootDir, kind: "squad-list" }) as {
          squads: Array<{ id: string; leader: string; workers: string[]; validity: string }>;
        }
      ).squads.map(({ id, leader, workers, validity }) => ({ id, leader, workers, validity })),
      [{ id: "core-squad", leader: "terra", workers: ["terra"], validity: "valid" }],
    );
    assert.deepEqual((run({ rootDir, kind: "agent-inspect", agentId: "terra" }) as { agent: unknown }).agent, agent);
    assert.equal(
      (run({ rootDir, kind: "squad-inspect", squadId: "core-squad" }) as { squad: { roster: string } }).squad.roster,
      squad.roster,
    );
    const edited = { ...squad, roster: "# Core Squad\n\nTerra leads; humans can edit this roster." };
    writeEntity(source, "core-squad", "squad", edited);
    await install({ rootDir, kind: "squad-install", packageSource: path.join(source, "core-squad") });
    assert.equal(
      (run({ rootDir, kind: "squad-inspect", squadId: "core-squad" }) as { squad: { roster: string } }).squad.roster,
      edited.roster,
    );
    assert.throws(
      () => run({ rootDir, kind: "agent-inspect", agentId: "unknown" }),
      (error: unknown) => (error as { code?: string }).code === "agent_not_found",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime_type is an open identifier: third-party runtimes validate while traversal and whitespace stay rejected", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-runtime-type-")),
    source = path.join(rootDir, "source");
  try {
    for (const runtime_type of ["any", "opencode", "dsh", "grok", "kiro", "glm"])
      assert.deepEqual(validateAgentDeclarationV1({ ...agent, id: "worker", runtime_type }), [], runtime_type);
    for (const runtime_type of ["../etc/passwd", "claude codex", " ", "Claude", "claude/../../bin", ""])
      assert.match(
        validateAgentDeclarationV1({ ...agent, id: "worker", runtime_type }).join("\n"),
        /runtime_type.*lowercase runtime identifier/u,
        runtime_type,
      );
    const opencode = { ...agent, id: "opencode-worker", name: "Opencode Worker", runtime_type: "opencode" };
    writeEntity(source, "opencode-worker", "agent", opencode);
    const report = run({ rootDir, kind: "agent-validate", packageSource: path.join(source, "opencode-worker") }) as {
      valid: boolean;
      entity?: { id: string };
    };
    assert.deepEqual(
      { valid: report.valid, entity: report.entity },
      { valid: true, entity: { id: "opencode-worker" } },
    );
    await install({ rootDir, kind: "agent-install", packageSource: path.join(source, "opencode-worker") });
    assert.equal(
      (run({ rootDir, kind: "agent-inspect", agentId: "opencode-worker" }) as { agent: { runtime_type: string } }).agent
        .runtime_type,
      "opencode",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("direct authored-file writes never enter the canonical Agent read surface", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-bypass-"));
  try {
    await install({ rootDir, kind: "agent-install", declaration: agent });
    const bypass = { ...agent, id: "bypass", name: "Bypass" },
      bypassPath = path.join(rootDir, "harness", "agents", "bypass.json");
    writeFileSync(bypassPath, `${JSON.stringify(bypass, null, 2)}\n`);

    const listed = run({ rootDir, kind: "agent-list" }) as { agents: Array<{ id: string }> };
    assert.deepEqual(
      listed.agents.map(({ id }) => id),
      ["terra"],
    );
    assert.throws(
      () => run({ rootDir, kind: "agent-inspect", agentId: "bypass" }),
      (error: unknown) => (error as { code?: string }).code === "agent_not_found",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("agent model is optional but must be non-empty when declared", () => {
  assert.deepEqual(validateAgentDeclarationV1({ ...agent, model: undefined }), []);
  for (const model of ["", " ", 42, []])
    assert.match(validateAgentDeclarationV1({ ...agent, model }).join("\n"), /model.*non-empty string/u);
});

test("daemon Agent fallback validation mirrors the kernel authority", () => {
  const fallback = {
    chain: [{ instance: "provider-a" }, { instance: "provider-b", model: "model-b" }],
    backoff: { baseMs: 25, maxMs: 100 },
  };
  assert.deepEqual(validateAgentDeclarationV1({ ...agent, fallback }), []);
  assert.match(
    validateAgentDeclarationV1({
      ...agent,
      fallback: { ...fallback, backoff: { ...fallback.backoff, maxMs: 20 } },
    }).join("\n"),
    /maxMs.*greater than or equal to baseMs/u,
  );
});

test("install preparation repairs a stored declaration rejected by the current schema", () => {
  const staleStore = {
      get: () => {
        throw Object.assign(new Error('agent declaration field "fallback.enabled" is unknown; remove it.'), {
          code: "invalid_entity_contract",
        });
      },
    } as never,
    prepared = prepareAgentEntityInstall({
      rootDir: "/unused",
      entityStore: staleStore,
      action: { kind: "agent-install", declaration: { ...agent, id: "glm-5-3", name: "GLM 5.3" } },
    });

  assert.equal(prepared.report.changed, true);
  assert.equal(prepared.declaration.id, "glm-5-3");
  assert.throws(
    () =>
      prepareAgentEntityInstall({
        rootDir: "/unused",
        entityStore: staleStore,
        action: {
          kind: "agent-install",
          declaration: { ...agent, id: "glm-5-3", name: "GLM 5.3" },
          generatedOnly: true,
          validated: true,
        },
      }),
    (error: unknown) => (error as { readonly code?: unknown }).code === "agent_id_conflict",
  );
});

test("install preparation does not hide stored declaration integrity failures", () => {
  const corruptStore = {
    get: () => {
      throw new Error("entity declaration blob hash mismatch");
    },
  } as never;
  assert.throws(
    () =>
      prepareAgentEntityInstall({
        rootDir: "/unused",
        entityStore: corruptStore,
        action: { kind: "agent-install", declaration: agent },
      }),
    /blob hash mismatch/u,
  );
});

test("Agent role is optional, closed to worker or commander, and defaults to worker in GUI projections", () => {
  assert.deepEqual(validateAgentDeclarationV1({ ...agent, role: "worker" }), []);
  assert.deepEqual(validateAgentDeclarationV1({ ...agent, role: "commander" }), []);
  assert.match(validateAgentDeclarationV1({ ...agent, role: "ceo" }).join("\n"), /role.*worker or commander/u);
});

test("Agent skills only accept unique exact {id, path} declarations", () => {
  for (const skills of [
    ["review"],
    [{ id: "review" }],
    [
      { id: "review", path: "skills/review" },
      { id: "review", path: "skills/another-review" },
    ],
  ])
    assert.match(
      validateAgentDeclarationV1({ ...agent, skills }).join("\n"),
      /skills.*unique \{id, path\}/u,
      JSON.stringify(skills),
    );
});

test("Squad leader turn budgets are required positive integers", () => {
  const { leaderTurnBudget: _leaderTurnBudget, ...missing } = squad;
  assert.match(validateSquadDeclarationV1(missing).join("\n"), /missing required field "leaderTurnBudget"/u);
  for (const leaderTurnBudget of [0, -1, 1.5, "8", null])
    assert.match(
      validateSquadDeclarationV1({ ...squad, leaderTurnBudget }).join("\n"),
      /leaderTurnBudget.*positive integer/u,
    );
  assert.deepEqual(validateSquadDeclarationV1(squad), []);
});

test("Agent skill discovery scans user and project roots and returns absolute selectable paths", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-agent-skill-discovery-")),
    rootDir = path.join(parent, "repo"),
    userHome = path.join(parent, "home"),
    userSkill = path.join(userHome, ".claude", "skills", "user-review"),
    userAgentSkill = path.join(userHome, ".agents", "skills", "agent-only"),
    userCodexSkill = path.join(userHome, ".codex", "skills", "codex-only"),
    userAgentShared = path.join(userHome, ".agents", "skills", "shared"),
    userCodexShared = path.join(userHome, ".codex", "skills", "shared"),
    projectSkill = path.join(rootDir, "harness", "skills", "project-test"),
    repoClaudeSkill = path.join(rootDir, ".claude", "skills", "repo-plan"),
    repoSkill = path.join(rootDir, "skills", "repo-shared"),
    repoAgentLink = path.join(rootDir, ".agents", "skills", "repo-shared"),
    linkedProjectSkill = path.join(parent, "linked-project-agent-only"),
    linkedProjectAgentLink = path.join(rootDir, ".agents", "skills", "project-agent-only"),
    archivedSkill = path.join(userHome, ".agents", "skills-archive", "archived"),
    disabledSkill = path.join(userHome, ".agents", "skills-disabled-2026-05-08", "disabled");
  try {
    for (const skillDir of [
      userSkill,
      userAgentSkill,
      userCodexSkill,
      userAgentShared,
      userCodexShared,
      projectSkill,
      repoClaudeSkill,
      repoSkill,
      linkedProjectSkill,
      archivedSkill,
      disabledSkill,
    ]) {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, "SKILL.md"), `# ${path.basename(skillDir)}\n`);
    }
    mkdirSync(path.dirname(repoAgentLink), { recursive: true });
    symlinkSync(repoSkill, repoAgentLink, "dir");
    symlinkSync(linkedProjectSkill, linkedProjectAgentLink, "dir");
    mkdirSync(path.join(rootDir, "harness", "skills", "incomplete"), { recursive: true });
    const expected = [
      { id: "agent-only", path: realpathSync(userAgentSkill), source: "user" },
      { id: "codex-only", path: realpathSync(userCodexSkill), source: "user" },
      { id: "linked-project-agent-only", path: realpathSync(linkedProjectSkill), source: "project" },
      { id: "project-test", path: realpathSync(projectSkill), source: "project" },
      { id: "repo-plan", path: realpathSync(repoClaudeSkill), source: "project" },
      { id: "repo-shared", path: realpathSync(repoSkill), source: "project" },
      { id: "shared", path: realpathSync(userAgentShared), source: "user" },
      { id: "shared", path: realpathSync(userCodexShared), source: "user" },
      { id: "user-review", path: realpathSync(userSkill), source: "user" },
    ].sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
    assert.deepEqual(discoverAgentSkills({ rootDir, userHome }), expected);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Agent skill discovery does not index nested skills embedded inside a catalog entry", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-agent-skill-nested-")),
    rootDir = path.join(parent, "repo"),
    userHome = path.join(parent, "home"),
    nestedSkill = path.join(userHome, ".agents", "skills", "workspace-snapshot", "old-skill");
  try {
    mkdirSync(nestedSkill, { recursive: true });
    writeFileSync(path.join(nestedSkill, "SKILL.md"), "# old skill\n");
    assert.deepEqual(discoverAgentSkills({ rootDir, userHome }), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Agent skill discovery requires the exact SKILL.md manifest name", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-agent-skill-case-")),
    rootDir = path.join(parent, "repo"),
    userHome = path.join(parent, "home"),
    malformedSkill = path.join(userHome, ".agents", "skills", "lowercase-manifest");
  try {
    mkdirSync(malformedSkill, { recursive: true });
    writeFileSync(path.join(malformedSkill, "skill.md"), "# wrong case\n");
    assert.deepEqual(discoverAgentSkills({ rootDir, userHome }), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Agent skills accept project-relative and absolute references and fail closed with repairable errors", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-skills-")),
    skillDir = path.join(rootDir, "harness", "skills", "review"),
    externalSkillDir = path.join(rootDir, "external", "outside");
  try {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: review\ndescription: Review\n---\nReview carefully.\n");
    mkdirSync(externalSkillDir, { recursive: true });
    writeFileSync(path.join(externalSkillDir, "SKILL.md"), "# Outside\n");
    const resolved = resolveAgentSkills({ rootDir, skills: [{ id: "review", path: "skills/review" }] });
    assert.deepEqual(
      resolved.map(({ id, sourceDir, skillFile }) => ({ id, sourceDir, skillFile })),
      [{ id: "review", sourceDir: realpathSync(skillDir), skillFile: path.join(realpathSync(skillDir), "SKILL.md") }],
    );
    assert.deepEqual(
      resolveAgentSkills({ rootDir, skills: [{ id: "outside", path: externalSkillDir }] }).map(({ id, sourceDir }) => ({
        id,
        sourceDir,
      })),
      [{ id: "outside", sourceDir: realpathSync(externalSkillDir) }],
    );
    assert.throws(
      () => resolveAgentSkills({ rootDir, skills: [{ id: "missing", path: "skills/missing" }] }),
      (error: unknown) =>
        (error as { code?: string; message?: string }).code === "agent_skill_not_found" &&
        /select an available skill directory.*SKILL\.md/u.test(String((error as Error).message)),
    );
    mkdirSync(path.join(rootDir, "harness", "skills", "broken"), { recursive: true });
    assert.throws(
      () => resolveAgentSkills({ rootDir, skills: [{ id: "broken", path: "skills/broken" }] }),
      (error: unknown) =>
        (error as { code?: string; message?: string }).code === "agent_skill_manifest_missing" &&
        /add SKILL\.md/u.test(String((error as Error).message)),
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("generated Agent output reuses validation, admits only runnable declarations, and never overwrites", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-generated-agent-")),
    source = path.join(rootDir, "source"),
    generated = { ...agent, id: "generated", name: "Generated", instructions: "Generated instructions." };
  try {
    writeEntity(source, generated.id, "agent", generated);
    const runtimeInstances = [{ kindId: "codex", models: ["gpt-5.6-sol", "gpt-5.6-terra"], enabled: true }];
    await assert.rejects(
      () =>
        install({
          rootDir,
          kind: "agent-install",
          packageSource: path.join(source, generated.id),
          generatedOnly: true,
          runtimeInstances,
        }),
      (error: unknown) => (error as { code?: string }).code === "agent_validation_required",
    );
    assert.equal(
      (
        (await install({
          rootDir,
          kind: "agent-install",
          packageSource: path.join(source, generated.id),
          generatedOnly: true,
          validated: true,
          runtimeInstances,
        })) as { entityId: string }
      ).entityId,
      generated.id,
    );
    await assert.rejects(
      () =>
        install({
          rootDir,
          kind: "agent-install",
          packageSource: path.join(source, generated.id),
          generatedOnly: true,
          validated: true,
          runtimeInstances,
        }),
      (error: unknown) =>
        (error as { code?: string; message?: string }).code === "agent_id_conflict" &&
        /ha agent inspect generated.*ha agent create/u.test(String((error as Error).message)),
    );
    const unknown = { ...generated, id: "unknown-generated", runtime_type: "opencode" };
    writeEntity(source, unknown.id, "agent", unknown);
    await assert.rejects(
      () =>
        install({
          rootDir,
          kind: "agent-install",
          packageSource: path.join(source, unknown.id),
          generatedOnly: true,
          validated: true,
          runtimeInstances,
        }),
      (error: unknown) =>
        (error as { code?: string; message?: string }).code === "agent_runtime_type_unavailable" &&
        /ha runtime instance list/u.test(String((error as Error).message)),
    );
    const unsupported = { ...generated, id: "unsupported-generated", model: "missing-model" };
    writeEntity(source, unsupported.id, "agent", unsupported);
    await assert.rejects(
      () =>
        install({
          rootDir,
          kind: "agent-install",
          packageSource: path.join(source, unsupported.id),
          generatedOnly: true,
          validated: true,
          runtimeInstances,
        }),
      (error: unknown) =>
        (error as { code?: string; message?: string }).code === "agent_model_unavailable" &&
        /ha runtime instance list/u.test(String((error as Error).message)),
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("entity validation names every malformed manifest and refuses squads that reference missing agents", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-entity-errors-")),
    source = path.join(rootDir, "source");
  try {
    writeEntity(source, "missing-runtime", "agent", {
      schema: "agent-declaration/v1",
      id: "missing-runtime",
      name: "Missing Runtime",
      instructions: "Review precisely.",
    });
    const missing = run({ rootDir, kind: "agent-validate", packageSource: path.join(source, "missing-runtime") }) as {
      valid: boolean;
      issues: Array<{ message: string }>;
    };
    assert.equal(missing.valid, false);
    assert.match(missing.issues.map(({ message }) => message).join("\n"), /missing required field "runtime_type"/u);
    writeEntity(source, "wrong-kind", "squad", squad);
    const mismatch = run({ rootDir, kind: "agent-validate", packageSource: path.join(source, "wrong-kind") }) as {
      valid: boolean;
      issues: Array<{ message: string }>;
    };
    assert.equal(mismatch.valid, false);
    assert.match(mismatch.issues.map(({ message }) => message).join("\n"), /missing agent\.json/u);
    writeEntity(source, "orphan-squad", "squad", { ...squad, id: "orphan-squad", leader: "ghost" });
    await install({ rootDir, kind: "squad-install", packageSource: path.join(source, "orphan-squad") });
    assert.throws(
      () => run({ rootDir, kind: "squad-inspect", squadId: "orphan-squad" }),
      (error: unknown) => (error as { code?: string }).code === "squad_agent_not_found",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// The GUI read contract (repo.agent.entities.list / repo.agent.entity.read and
// the squad twins) consumes exactly this closed projection; keep its shape fixed.
test("the GUI entity projection lists closed rows and reads closed declarations", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-entities-gui-")),
    source = path.join(rootDir, "source");
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    writeEntity(source, "terra", "agent", agent);
    writeEntity(source, "core-squad", "squad", squad);
    await install({ rootDir, kind: "agent-install", packageSource: path.join(source, "terra") });
    await install({ rootDir, kind: "squad-install", packageSource: path.join(source, "core-squad") });
    const eventStore = makeTaskEventStore({ repoId: "agent-entities-gui", rootDir });
    let canonicalReads = 0;
    const guardedEventStore = {
      ...eventStore,
      read: () => {
        canonicalReads += 1;
        return eventStore.read();
      },
    };
    projection = makeTaskProjection({ rootDir, eventStore: guardedEventStore });
    const agentRows = readAgentEntityGuiProjection({ kind: "agent-list", projection }),
      squadRows = readAgentEntityGuiProjection({ kind: "squad-list", projection });
    assert.equal(agentRows.schema, "agent-entity-catalog/v1");
    assert.equal(agentRows.ok, true);
    assert.deepEqual(
      agentRows.agents.map(({ id, runtimeType, role, layer, validity }) => ({
        id,
        runtimeType,
        role,
        layer,
        validity,
      })),
      [{ id: "terra", runtimeType: "codex", role: "worker", layer: "user", validity: "valid" }],
    );
    assert.deepEqual(Object.keys(agentRows.agents[0]!).sort(), [
      "id",
      "issues",
      "layer",
      "name",
      "role",
      "runtimeType",
      "validity",
    ]);
    assert.equal(squadRows.schema, "squad-entity-catalog/v1");
    assert.equal(squadRows.ok, true);
    assert.deepEqual(
      squadRows.squads.map(({ id, leader, workers }) => ({ id, leader, workers })),
      [{ id: "core-squad", leader: "terra", workers: ["terra"] }],
    );
    const agentDetail = readAgentEntityGuiProjection({
        kind: "agent-inspect",
        entityId: "terra",
        projection,
      }),
      squadDetail = readAgentEntityGuiProjection({
        kind: "squad-inspect",
        entityId: "core-squad",
        projection,
      });
    assert.equal(canonicalReads, 0, "GUI projection reads must not replay the canonical event stream");
    assert.equal(agentDetail.ok, true);
    assert.equal(squadDetail.ok, true);
    assert.deepEqual(agentDetail.agent, {
      id: "terra",
      name: "Terra",
      runtimeType: "codex",
      role: "worker",
      instructions: "Review precisely.",
      model: "gpt-5.6-terra",
      skills: [{ id: "review", path: "skills/review" }],
      prompts: ["prompt://review"],
      preset: "standard-task",
      fallback: null,
    });
    assert.deepEqual(squadDetail.squad, {
      id: "core-squad",
      name: "Core Squad",
      leader: "terra",
      workers: ["terra"],
      leaderTurnBudget: 8,
      roster: squad.roster,
    });
    assert.throws(
      () => readAgentEntityGuiProjection({ kind: "agent-inspect", entityId: "unknown", projection: projection! }),
      (error: unknown) => (error as { code?: string }).code === "agent_not_found",
    );
  } finally {
    projection?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Squad dispatch resolution selects one declared worker and rejects outsiders or ambiguous lineage", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-dispatch-")),
    source = path.join(rootDir, "source"),
    fable = { ...agent, id: "fable", name: "Fable" },
    luna = { ...agent, id: "luna", name: "Luna" },
    outsider = { ...agent, id: "outsider", name: "Outsider" };
  try {
    for (const declaration of [fable, luna, outsider]) {
      writeEntity(source, declaration.id, "agent", declaration);
      await install({ rootDir, kind: "agent-install", packageSource: path.join(source, declaration.id) });
    }
    writeEntity(source, "core-squad", "squad", { ...squad, leader: "fable", workers: ["luna"] });
    await install({ rootDir, kind: "squad-install", packageSource: path.join(source, "core-squad") });
    assert.deepEqual(resolveSquadDispatch({ rootDir, leaderId: "fable", workerId: "luna" }), {
      squadId: "core-squad",
      leader: fable,
      worker: luna,
    });
    assert.throws(
      () => resolveSquadDispatch({ rootDir, leaderId: "fable", workerId: "outsider" }),
      (error: unknown) => (error as { code?: string }).code === "squad_member_not_found",
    );
    writeEntity(source, "other-squad", "squad", {
      ...squad,
      id: "other-squad",
      name: "Other Squad",
      leader: "fable",
      workers: ["luna"],
    });
    await install({ rootDir, kind: "squad-install", packageSource: path.join(source, "other-squad") });
    assert.throws(
      () => resolveSquadDispatch({ rootDir, leaderId: "fable", workerId: "luna" }),
      (error: unknown) => (error as { code?: string }).code === "squad_member_ambiguous",
    );
    writeFileSync(path.join(rootDir, "harness/squads/broken.json"), "{not-json\n");
    assert.throws(
      () => resolveSquadDispatch({ rootDir, leaderId: "fable", workerId: "luna" }),
      (error: unknown) => (error as { code?: string }).code === "squad_member_ambiguous",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("GUI declaration writes validate before installing and preserve roster bytes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-entities-gui-write-")),
    roster = "## Blue Squad\n\n  Fable leads.\n\n";
  try {
    await install({ rootDir, kind: "agent-install", declaration: { ...agent, id: "gui-agent", name: "GUI Agent" } });
    await install({
      rootDir,
      kind: "squad-install",
      declaration: {
        ...squad,
        id: "gui-squad",
        name: "GUI Squad",
        leader: "gui-agent",
        workers: ["gui-agent"],
        roster,
      },
    });
    assert.equal(
      (run({ rootDir, kind: "squad-inspect", squadId: "gui-squad" }) as { squad: { roster: string } }).squad.roster,
      roster,
    );
    await assert.rejects(
      () => install({ rootDir, kind: "agent-install", declaration: { ...agent, id: "Bad ID" } }),
      (error: unknown) => (error as { code?: string }).code === "invalid_manifest",
    );
    assert.equal(existsSync(path.join(rootDir, "harness", "agents", "Bad ID.json")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

interface TestEntityAction {
  readonly rootDir: string;
  readonly kind: string;
  readonly packageSource?: string;
  readonly declaration?: Record<string, unknown>;
  readonly agentId?: string;
  readonly squadId?: string;
  readonly generatedOnly?: boolean;
  readonly validated?: boolean;
  readonly runtimeInstances?: readonly {
    readonly kindId: string;
    readonly models: readonly string[];
    readonly enabled: boolean;
  }[];
}

function run(input: TestEntityAction): unknown {
  return runAgentEntityAction({
    rootDir: input.rootDir,
    runtimeInstances: input.runtimeInstances,
    action: entityAction(input),
  });
}

async function install(input: TestEntityAction): Promise<unknown> {
  initRepo(input.rootDir);
  const action = entityAction(input),
    prepared = prepareAgentEntityInstall({
      rootDir: input.rootDir,
      runtimeInstances: input.runtimeInstances,
      action,
    }),
    store = makeTaskEventStore({ repoId: "agent-entities", rootDir: input.rootDir }),
    revision = store.readHead()?.revision ?? 0,
    bundle = createEntityStore(store).upsert({
      entityKind: prepared.kind,
      entity: prepared.declaration,
      eventId: `event-${prepared.kind}-${prepared.declaration.id}-${revision + 1}`,
      opId: `op-${prepared.kind}-${prepared.declaration.id}-${revision + 1}`,
      workspaceRevision: revision + 1,
      actor: { principal: { personId: "agent-entities-test" }, executor: null },
      source: "local",
      occurredAt: "2026-08-25T00:00:00.000Z",
    });
  store.append(bundle);
  await store.drain();
  return prepared.report;
}

function entityAction(input: TestEntityAction): Readonly<Record<string, unknown>> & { readonly kind: string } {
  return {
    kind: input.kind,
    ...(input.packageSource ? { packageSource: input.packageSource } : {}),
    ...(input.declaration ? { declaration: input.declaration } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.squadId ? { squadId: input.squadId } : {}),
    ...(input.generatedOnly ? { generatedOnly: true } : {}),
    ...(input.validated ? { validated: true } : {}),
  };
}

function initRepo(rootDir: string): void {
  if (existsSync(path.join(rootDir, ".git"))) return;
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Agent Entities Test");
  git(rootDir, "config", "user.email", "agent-entities@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
}

function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

function writeEntity(source: string, id: string, kind: "agent" | "squad", declaration: Record<string, unknown>): void {
  const target = path.join(source, id);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    path.join(target, kind === "agent" ? "agent.json" : "squad.json"),
    `${JSON.stringify(declaration, null, 2)}\n`,
  );
}
