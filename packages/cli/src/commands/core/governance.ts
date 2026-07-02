import { Effect } from "effect";
import { runCheckProfile } from "../check.ts";
import { runGovernanceRebuild } from "../governance.ts";
import { runLessonPromote, runLessonSediment } from "../lesson.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

type GovernanceAction = Extract<
  Parameters<CommandRunner>[1]["action"],
  { readonly kind: "check" | "governance-rebuild" | "lesson-promote" | "lesson-sediment" }
>;

export const runGovernanceCommand: CommandRunner = (context, command) => {
  const action = command.action as GovernanceAction;
  switch (action.kind) {
    case "check":
      return Effect.sync(() => runCheckProfile(context.layoutInput, action));
    case "governance-rebuild":
      return Effect.sync(() => runGovernanceRebuild(context.layoutInput, action.mode));
    case "lesson-promote":
      return Effect.sync(() => runLessonPromote(context.layoutInput, action.taskId, action.candidateId, action.mode));
    case "lesson-sediment":
      return Effect.sync(() => runLessonSediment(context.layoutInput, action.taskId, action.candidateId, action.title));
  }
};
