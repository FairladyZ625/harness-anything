import { Effect } from "effect";
import { runDoctor } from "../doctor.ts";
import { runGitDiffEvidence } from "../git-diff.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

type DiagnosticsAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "git-diff" | "doctor" }>;

export const runDiagnosticsCommand: CommandRunner = (context, command) => {
  const action = command.action as DiagnosticsAction;
  if (action.kind === "git-diff") return Effect.sync(() => runGitDiffEvidence(command.rootDir, action.baseRef));
  return Effect.sync(() => runDoctor(context.layoutInput));
};
