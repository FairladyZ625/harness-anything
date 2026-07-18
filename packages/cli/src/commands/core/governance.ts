import { Effect } from "effect";
import { runCheckProfile } from "../check.ts";
import { runGovernanceRebuild } from "../governance.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

type GovernanceAction = Extract<
  Parameters<CommandRunner>[1]["action"],
  { readonly kind: "check" | "governance-rebuild" }
>;

export const runGovernanceCommand: CommandRunner = (context, command) => {
  const action = command.action as GovernanceAction;
  switch (action.kind) {
    case "check":
      return Effect.sync(() => runCheckProfile(context.layoutInput, action, context.commandRegistry));
    case "governance-rebuild":
      return Effect.sync(() => runGovernanceRebuild(context.layoutInput, action.mode));
  }
};
