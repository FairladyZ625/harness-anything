import { Effect } from "effect";
import { runDoctor } from "../doctor.ts";
import { runGitDiffEvidence } from "../git-diff.ts";
import { runGraphCommand } from "../graph.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

type DiagnosticsAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "git-diff" | "doctor" | "graph" }>;

export const runDiagnosticsCommand: CommandRunner = (context, command) => {
  const action = command.action as DiagnosticsAction;
  if (action.kind === "git-diff") return Effect.sync(() => runGitDiffEvidence(command.rootDir, action.baseRef));
  if (action.kind === "graph") return Effect.sync(() => runGraphCommand(command.rootDir, action));
  return Effect.sync(() => runDoctor(context.layoutInput));
};
