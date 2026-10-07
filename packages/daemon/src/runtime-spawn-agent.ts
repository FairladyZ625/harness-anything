import { presetDocumentBody } from "@harness-anything/preset/internal/preset-resolver";
import { presetRuntimeDefaults, presetUserRoot } from "@harness-anything/preset/internal/preset-system";
import { resolveAgentSkills } from "./agent-skills.ts";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";
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
    resolvedSkills = (agent ? resolveAgentSkills({ rootDir: input.rootDir, skills: agent.skills }) : []).map(
      (skill) => ({ ...skill, skillFile: workerLedgerPath(input.rootDir, cwd, skill.skillFile) }),
    ),
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
            userRoot: presetUserRoot(input.rootDir),
            verticalId: defaults.verticalId,
            presetId: agent.preset!,
          });
        })()
      : undefined;
  return { squad, delegatedBy, agent, resolvedSkills, preset };
}
