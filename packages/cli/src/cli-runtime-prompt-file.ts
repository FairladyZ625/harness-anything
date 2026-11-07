import { readWorkspaceTextFile } from "./cli-workspace-file.ts";
import type { ThinCommand } from "./cli/thin-command.ts";

export function materializePromptFile(command: ThinCommand): ThinCommand {
  if (
    (command.action.kind !== "runtime-run" && command.action.kind !== "runtime-steer") ||
    typeof command.action.promptFile !== "string"
  )
    return command;
  const prompt = readWorkspaceTextFile(command.rootDir, command.action.promptFile, "--prompt-file");
  const { promptFile: _promptFile, ...action } = command.action;
  return { ...command, action: { ...action, prompt } };
}
