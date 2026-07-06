import { commandSpecMap, type CommandKind } from "./command-spec/index.ts";
import type { CommandParserId, CommandRunnerId } from "./command-spec/types.ts";

export const commandParserIds = commandSpecMap((entry) => entry.parserId) satisfies Record<CommandKind, CommandParserId>;

export const commandRunnerIds = commandSpecMap((entry) => entry.runnerId) satisfies Record<CommandKind, CommandRunnerId>;
