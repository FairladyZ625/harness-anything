// harness-test-tier: fast
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_AGENT_HOST_ACCESS, resolveAgentHostAccess } from "@harness-anything/kernel";
import { agentRolePrompt } from "../src/agent-role-prompts.ts";

// The regression shape: a second, literal default for the dispatch host access. The Kernel
// constant is the only place the default may be written.
const literalDefault = /hostAccess\s*:\s*AgentHostAccess\s*=\s*["'](?:isolated|operator|bypass)["']/u;

function daemonSourceFiles(): readonly string[] {
  return readdirSync(new URL("../src/", import.meta.url), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".ts"));
}

test("the undeclared hostAccess default has one Kernel definition and the daemon references it", () => {
  assert.equal(DEFAULT_AGENT_HOST_ACCESS, "operator");
  assert.deepEqual(resolveAgentHostAccess(undefined), {
    hostAccess: "operator",
    hostAccessSource: "default",
  });
  for (const hostAccess of ["isolated", "operator", "bypass"] as const)
    assert.deepEqual(resolveAgentHostAccess(hostAccess), { hostAccess, hostAccessSource: "declared" });

  const rolePrompts = readFileSync(new URL("../src/agent-role-prompts.ts", import.meta.url), "utf8");
  assert.match(rolePrompts, /DEFAULT_AGENT_HOST_ACCESS/u);
  assert.doesNotMatch(rolePrompts, literalDefault);
  assert.match(agentRolePrompt(undefined), /Host access: operator/u);

  const violations = daemonSourceFiles().flatMap((file) => {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    return literalDefault.test(source) ? [file] : [];
  });
  assert.deepEqual(violations, [], "the daemon must resolve the host-access default from the Kernel constant");

  // Positive control: the detector catches the exact regression the gate exists for.
  assert.match('function agentRolePrompt(role, hostAccess: AgentHostAccess = "isolated")', literalDefault);
});
