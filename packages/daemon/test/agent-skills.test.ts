// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDeclarationV1 } from "@harness-anything/kernel";
import { mergeRepositorySkills } from "../src/agent-skills.ts";
import { resolveDispatchAgent } from "../src/runtime-spawn-agent.ts";

const agent = {
  schema: "agent-declaration/v1",
  id: "portable-worker",
  name: "Portable Worker",
  instructions: "Do the work.",
  runtimes: [],
} satisfies AgentDeclarationV1;

function tempRepo(skillNames: readonly string[]): string {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-agent-skills-")));
  for (const skill of skillNames) {
    mkdirSync(path.join(rootDir, "harness", "skills", skill), { recursive: true });
    writeFileSync(path.join(rootDir, "harness", "skills", skill, "SKILL.md"), `# ${skill}\n`);
  }
  return rootDir;
}

test("repository skills mount beside a portable Agent declaration", () => {
  const rootDir = tempRepo(["test-isolation"]);
  try {
    const resolved = resolveDispatchAgent(
      {
        rootDir,
        resolveAgent: () => agent,
        readSettings: () => ({ runtime: { agentSkills: ["skills/test-isolation"] } }),
      } as never,
      {} as never,
      rootDir,
      agent.id,
      undefined,
      undefined,
    );
    assert.deepEqual(
      resolved.resolvedSkills.map(({ id, skillFile }) => ({ id, skillFile })),
      [{ id: "test-isolation", skillFile: path.join(rootDir, "harness", "skills", "test-isolation", "SKILL.md") }],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a repository skill with the Agent's own id does not duplicate the mount", () => {
  assert.deepEqual(
    mergeRepositorySkills(
      [{ id: "test-isolation", path: "skills/test-isolation" }],
      ["skills/test-isolation", "skills/repository-only"],
    ),
    [
      { id: "test-isolation", path: "skills/test-isolation" },
      { id: "repository-only", path: "skills/repository-only" },
    ],
  );
});

test("a stale declaration's missing skill names the Agent and the repair command", () => {
  const rootDir = tempRepo([]);
  try {
    assert.throws(
      () =>
        resolveDispatchAgent(
          {
            rootDir,
            resolveAgent: () => ({ ...agent, skills: [{ id: "test-isolation", path: "skills/test-isolation" }] }),
            readSettings: () => ({ runtime: { agentSkills: [] } }),
          } as never,
          {} as never,
          rootDir,
          agent.id,
          undefined,
          undefined,
        ),
      (error: unknown) =>
        (error as { code?: string; message?: string }).code === "agent_skill_not_found" &&
        /Agent portable-worker cannot dispatch/u.test(String((error as Error).message)) &&
        /ha agent install --source/u.test(String((error as Error).message)),
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a configured repository skill that is missing still fails the dispatch", () => {
  const rootDir = tempRepo([]);
  try {
    assert.throws(
      () =>
        resolveDispatchAgent(
          {
            rootDir,
            resolveAgent: () => agent,
            readSettings: () => ({ runtime: { agentSkills: ["skills/not-there"] } }),
          } as never,
          {} as never,
          rootDir,
          agent.id,
          undefined,
          undefined,
        ),
      (error: unknown) =>
        (error as { code?: string; message?: string }).code === "agent_skill_not_found" &&
        /skills\/not-there/u.test(String((error as Error).message)),
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
