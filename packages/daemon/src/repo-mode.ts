import type { DaemonRepoMode, WriteSource } from "../../kernel/src/index.ts";
import type { CommandTopology } from "../../preset/src/preset-command-contract.ts";

export interface RepoModeAdmission {
  readonly ok: boolean;
  readonly code: string;
  readonly nextAction: string;
}
const rejection = (code: string, nextAction: string): RepoModeAdmission => ({
  ok: false,
  code,
  nextAction,
});

export function admitRepoMode(
  mode: DaemonRepoMode,
  command: Pick<CommandTopology, "admission">,
  source: WriteSource,
): RepoModeAdmission {
  const route = command.admission[mode],
    assignment = typeof source === "object" && source.kind === "assignment";
  if (mode === "local" && source === "remote_direct")
    return rejection(
      "repo_mode_rejects_direct_remote",
      "Use authenticated assignment ingress for remote commands; direct remote writes are not admitted.",
    );
  if (route === "direct" && !(mode === "remote-edge" && assignment))
    return { ok: true, code: "repo_mode_admitted", nextAction: "Continue." };
  if (route === "via-assignment" && assignment)
    return { ok: true, code: "repo_mode_admitted", nextAction: "Continue." };
  if (route === "via-assignment")
    return rejection(
      "repo_mode_requires_center_ingress",
      "Send write commands through the authenticated Fleet assignment ingress; local direct writes are disabled for remote-center repositories.",
    );
  if (route === "via-center-forward")
    return rejection(
      "repo_mode_read_only",
      "Forward this command to the remote center; the remote-edge repository does not author ledger state.",
    );
  if (mode === "remote-edge")
    return rejection("repo_mode_read_only", "This command has no remote-edge route in its daemon command descriptor.");
  return rejection(
    "repo_mode_command_rejected",
    `The daemon command descriptor explicitly rejects this command in ${mode} mode.`,
  );
}
