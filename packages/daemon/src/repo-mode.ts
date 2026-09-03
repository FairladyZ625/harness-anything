import { getExecutableEntityAction, type DaemonRepoMode, type WriteSource } from "../../kernel/src/index.ts";
import type { CommandTopology } from "../../preset/src/preset-command-contract.ts";

export interface RepoModeAdmission {
  readonly ok: boolean;
  readonly code: string;
  readonly nextAction: string;
}
export function repoModeAdmission(ok: boolean, code: string): RepoModeAdmission {
  const nextAction = code;
  return { ok, code, nextAction };
}
const rejection = (code: string): RepoModeAdmission => repoModeAdmission(false, code);

/** Resolve field-scoped local effects declared by an executable Entity Action contract. */
export function entityActionCommandTopology(
  command: CommandTopology,
  action: Readonly<Record<string, unknown>> & { readonly kind?: string },
): CommandTopology {
  const localOnlyFields = action.kind ? (getExecutableEntityAction(action.kind)?.execution?.localOnlyFields ?? []) : [],
    mutationFields = Object.keys(action).filter(
      (field) => !["kind", "idempotencyKey", "expectedVersion"].includes(field),
    );
  if (mutationFields.length === 0 || mutationFields.some((field) => !localOnlyFields.includes(field))) return command;
  return {
    ...command,
    admission: {
      local: "direct",
      "remote-proxy": "rejected",
      "remote-center": "direct",
      "remote-edge": "direct",
    },
  };
}

export function admitRepoMode(
  mode: DaemonRepoMode,
  command: Pick<CommandTopology, "admission">,
  source: WriteSource,
): RepoModeAdmission {
  if (mode === "remote-proxy") return rejection("repo_mode_remote_proxy");
  const route = command.admission[mode],
    assignment = typeof source === "object" && source.kind === "assignment";
  if (mode === "local" && source === "remote_direct") return rejection("repo_mode_rejects_direct_remote");
  if (route === "direct" && !(mode === "remote-edge" && assignment))
    return repoModeAdmission(true, "repo_mode_admitted");
  if (route === "via-assignment" && assignment) return repoModeAdmission(true, "repo_mode_admitted");
  if (route === "via-assignment") return rejection("repo_mode_requires_center_ingress");
  if (route === "via-center-forward") return rejection("repo_mode_read_only");
  if (mode === "remote-edge") return rejection("repo_mode_read_only");
  return rejection("repo_mode_command_rejected");
}
