import { presetDocumentBody } from "@harness-anything/preset/internal/preset-resolver";
import { presetRuntimeDefaults, presetUserRoot } from "@harness-anything/preset/internal/preset-system";
import type { AgentSkillDeclarationV1 } from "@harness-anything/kernel";
import { mergeRepositorySkills, resolveAgentSkills } from "./agent-skills.ts";
import { runtimeErrorCode, runtimeSpawnError } from "./runtime-spawn-errors.ts";
import type { RuntimeBinding, RuntimeSpawnerInput } from "./runtime-spawn-types.ts";
import { workerLedgerPath } from "./worktree-setup.ts";

/** Resolve the dispatch identity and its prompt resources in the worker's checkout. */
export function resolveDispatchAgent(
  input: RuntimeSpawnerInput,
  binding: RuntimeBinding,
  cwd: string,
  agentId: string | undefined,
  squadId: string | undefined,
  targetAgentId: string | undefined,
) {
  const squad =
      squadId || targetAgentId
        ? (input.resolveSquadDispatch?.(squadId, agentId!, targetAgentId, binding) ??
          (() => {
            if (squadId) throw runtimeSpawnError("squad_not_found", `Squad ${squadId} is unavailable.`);
            throw runtimeSpawnError(
              "squad_member_not_found",
              `Agent ${targetAgentId} is not available in a squad led by ${agentId}.`,
            );
          })())
        : null,
    delegatedBy = squad?.worker ? squad.leader : null,
    agent =
      squad?.worker ??
      squad?.leader ??
      (agentId
        ? (input.resolveAgent?.(agentId) ??
          (() => {
            throw runtimeSpawnError("agent_not_found", `Agent ${agentId} is unavailable.`);
          })())
        : null),
    resolvedSkills = agent ? resolveDispatchSkills(input, cwd, agent) : [],
    preset = agent?.preset
      ? (() => {
          if (!input.readSettings)
            throw runtimeSpawnError(
              "settings_projection_unavailable",
              "Agent preset resolution requires the repository Settings projection.",
            );
          const defaults = presetRuntimeDefaults(input.readSettings());
          // The spawn prompt needs the preset's PRESET.md text only; a full resolve would
          // re-hash the whole catalog for a body the catalog already decoded.
          return presetDocumentBody({
            repoRoot: input.rootDir,
            userRoot: presetUserRoot(input.rootDir),
            verticalId: defaults.verticalId,
            presetId: agent.preset!,
          });
        })()
      : undefined;
  return { squad, delegatedBy, agent, resolvedSkills, preset };
}

/**
 * A missing skill is a property of one selected Agent, not of the dispatch machinery: name the
 * Agent and the repair command so an operator holding an old installed declaration can act
 * without reading the daemon source. The code and the underlying path stay unchanged.
 */
function resolveDispatchSkills(
  input: RuntimeSpawnerInput,
  cwd: string,
  agent: { readonly id: string; readonly skills?: readonly AgentSkillDeclarationV1[] },
) {
  try {
    return resolveAgentSkills({
      rootDir: input.rootDir,
      skills: mergeRepositorySkills(agent.skills, input.readSettings?.().runtime.agentSkills),
    }).map((skill) => ({ ...skill, skillFile: workerLedgerPath(input.rootDir, cwd, skill.skillFile) }));
  } catch (error) {
    const code = runtimeErrorCode(error);
    if (code !== "agent_skill_not_found" && code !== "agent_skill_manifest_missing") throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw runtimeSpawnError(
      code,
      `Agent ${agent.id} cannot dispatch because a declared skill is unavailable in this repository: ${message} ` +
        `Reinstall ${agent.id} with a declaration that resolves here (ha agent install --source <declaration>), ` +
        "or add the missing directory.",
    );
  }
}
