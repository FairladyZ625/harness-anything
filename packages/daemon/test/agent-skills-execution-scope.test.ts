// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BuiltinPolicyAdapter } from "@harness-anything/authorization-builtin";
import { readAgentSkillsGui } from "../src/agent-skills.ts";
import { createRepoCellApi, repoCellSynchronousRead } from "../src/repo-cell-api.ts";
import { daemonGuiReadMethods } from "../src/protocol/daemon-protocol.contract.ts";
import {
  authenticateRuntimeExecutionCredential,
  issueRuntimeExecutionCredential,
  runtimeExecutionLifetimeMs,
} from "../src/runtime-execution-credential.ts";
import { requireExecutionRequestScope } from "../src/runtime-execution-scope.ts";

const principal = () => ({
    personId: "person-skills",
    repoId: "repo-skills",
    runtimeSessionId: "runtime-skills",
    dispatchId: "dispatch-skills",
    taskId: "task-skills",
    executionId: "execution-skills",
    role: "implementation" as const,
    source: "local" as const,
    expiresAt: new Date(Date.now() + runtimeExecutionLifetimeMs - 1000).toISOString(),
  }),
  readOnlyPrincipal = () => ({ ...principal(), role: "read-only" as const, taskId: null, executionId: null }),
  repositoryParams = (p: ReturnType<typeof principal>, repoId = p.repoId) => ({
    repo: { repoId },
    payload: {},
  });

test("a repository execution principal reads the skill catalog", () => {
  const p = principal();
  for (const role of ["implementation", "reviewer", "session"] as const)
    assert.doesNotThrow(
      () => requireExecutionRequestScope({ ...p, role }, "repo.agent.skills.list", repositoryParams(p)),
      role,
    );
});

test("the skill catalog stays scoped to the credential's repository", () => {
  const p = principal();
  assert.throws(() => requireExecutionRequestScope(p, "repo.agent.skills.list", repositoryParams(p, "repo-other")), {
    code: "execution_credential_rejected",
  });
});

test("a read-only dispatch cannot read the skill catalog", () => {
  const p = readOnlyPrincipal();
  assert.throws(() => requireExecutionRequestScope(p, "repo.agent.skills.list", repositoryParams(p)), {
    code: "execution_credential_rejected",
    message: /allowlisted ledger queries/u,
  });
});

test("opening one GUI read does not open the GUI read family", () => {
  const p = principal(),
    admitted = daemonGuiReadMethods
      .filter(({ method }) => {
        try {
          requireExecutionRequestScope(p, method, repositoryParams(p));
          return true;
        } catch {
          return false;
        }
      })
      .map(({ method }) => method);
  // The already-open repository reads are retained deliberately; the skills catalog is the
  // only addition. A new GUI read entering this list is a policy change, not an accident.
  assert.deepEqual(admitted.sort(), [
    "repo.agenda.read",
    "repo.agent.skills.list",
    "repo.agentRuntime.overview",
    "repo.entity.actions.explain",
    "repo.settings.read",
    "repo.task.dispatches",
  ]);
});

test("a revoked execution credential is rejected before the skill catalog read", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-skill-execution-revoked-"));
  try {
    const provider = new BuiltinPolicyAdapter({ userRoot });
    provider.addUser({
      username: "owner",
      personId: "person-skills",
      email: "owner@example.invalid",
      displayName: "Owner",
      password: "fixture-password",
    });
    const localCenter = {
        provider,
        url: "builtin://local",
        realm: "local",
        clientId: "harness-center",
        accessToken: provider.issueCenterToken(),
      },
      p = principal(),
      noNetwork: typeof fetch = async () => {
        throw new Error("built-in execution credentials never call the network");
      },
      credential = await issueRuntimeExecutionCredential(localCenter, p, noNetwork);
    provider.removeSession(credential);
    let reachedCatalog = false;
    await assert.rejects(
      (async () => {
        const authenticated = await authenticateRuntimeExecutionCredential(localCenter, credential, noNetwork);
        reachedCatalog = true;
        requireExecutionRequestScope(authenticated, "repo.agent.skills.list", repositoryParams(authenticated));
      })(),
      { code: "execution_credential_rejected" },
    );
    assert.equal(reachedCatalog, false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("the execution catalog keeps only project skills with repository-relative paths", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-skill-execution-catalog-")),
    rootDir = path.join(parent, "repo"),
    userHome = path.join(parent, "home"),
    userSkill = path.join(userHome, ".claude", "skills", "user-review"),
    projectSkill = path.join(rootDir, "harness", "skills", "repo-review");
  try {
    for (const skillDir of [userSkill, projectSkill]) {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, "SKILL.md"), `# ${path.basename(skillDir)}\n`);
    }
    const gui = readAgentSkillsGui(rootDir, { userHome }),
      execution = readAgentSkillsGui(rootDir, { userHome, projection: "execution" });
    assert.deepEqual(
      gui.skills.map(({ id, path: skillPath, source }) => ({ id, path: skillPath, source })),
      [
        { id: "repo-review", path: realpathSync(projectSkill), source: "project" },
        { id: "user-review", path: realpathSync(userSkill), source: "user" },
      ].sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path)),
    );
    assert.deepEqual(execution.skills, [{ id: "repo-review", path: "harness/skills/repo-review", source: "project" }]);
    assert.equal(
      execution.skills.every(({ path: skillPath }) => !path.isAbsolute(skillPath)),
      true,
      "an execution catalog never carries a host path",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test(
  "a linked project skill outside the repository is omitted from the execution catalog",
  { skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false },
  () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-skill-execution-linked-")),
      rootDir = path.join(parent, "repo"),
      userHome = path.join(parent, "home"),
      outsideSkill = path.join(parent, "outside-skill"),
      outsideLink = path.join(rootDir, ".agents", "skills", "outside-skill");
    try {
      mkdirSync(outsideSkill, { recursive: true });
      writeFileSync(path.join(outsideSkill, "SKILL.md"), "# outside\n");
      mkdirSync(path.dirname(outsideLink), { recursive: true });
      symlinkSync(outsideSkill, outsideLink, "dir");
      const gui = readAgentSkillsGui(rootDir, { userHome }),
        execution = readAgentSkillsGui(rootDir, { userHome, projection: "execution" });
      assert.deepEqual(
        gui.skills.map(({ id, path: skillPath, source }) => ({ id, path: skillPath, source })),
        [{ id: "outside-skill", path: realpathSync(outsideSkill), source: "project" }],
      );
      assert.deepEqual(execution.skills, []);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test("the repo cell applies the execution projection from the read binding", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-skill-execution-cell-")),
    skillDir = path.join(rootDir, "skills", "repo-review");
  try {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "# repo-review\n");
    const api = createRepoCellApi({
        state: "attached",
        rootDir,
        input: { repoId: "repo-skills" },
        extracted: {},
        dispatchRead: (
          handlers: Readonly<Record<string, (payload: unknown, binding?: unknown) => unknown>>,
          method: string,
          payload: unknown,
          binding?: unknown,
        ) => handlers[method]!(payload, binding),
      } as never),
      binding = { actor: { principal: { personId: "person-skills" }, executor: null }, source: "local" as const },
      gui = api[repoCellSynchronousRead]("repo.agent.skills.list", {}, binding),
      execution = api[repoCellSynchronousRead](
        "repo.agent.skills.list",
        {},
        {
          ...binding,
          executionPrincipal: principal(),
        },
      );
    assert.equal(gui.skills[0]?.path, realpathSync(skillDir));
    assert.deepEqual(execution.skills, [{ id: "repo-review", path: "skills/repo-review", source: "project" }]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
