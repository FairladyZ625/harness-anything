import { Effect } from "effect";
import { runCheckProfile } from "../check.ts";
import { runGovernanceRebuild } from "../governance.ts";
import { runLessonPromote, runLessonSediment } from "../lesson.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

type GovernanceAction = Extract<
  Parameters<CommandRunner>[1]["action"],
  { readonly kind: "check" | "governance-rebuild" | "lesson-promote" | "lesson-sediment" }
>;

export const runGovernanceCommand: CommandRunner = (_context, command) => {
  const action = command.action as GovernanceAction;
  switch (action.kind) {
    case "check":
      return Effect.sync(() => runCheckProfile(command.rootDir, action));
    case "governance-rebuild":
      return Effect.sync(() => runGovernanceRebuild(command.rootDir, action.mode));
    case "lesson-promote":
      return Effect.sync(() => runLessonPromote(command.rootDir, action.taskId, action.candidateId, action.mode));
    case "lesson-sediment":
      return Effect.sync(() => runLessonSediment(command.rootDir, action.taskId, action.candidateId, action.title));
  }
};
