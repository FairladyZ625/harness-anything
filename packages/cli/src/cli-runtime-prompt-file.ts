import { readFileSync } from "node:fs";
import path from "node:path";
import type { ThinCommand } from "./cli/thin-command.ts";

export function materializePromptFile(command: ThinCommand): ThinCommand {
  if (command.action.kind !== "runtime-run" || typeof command.action.promptFile !== "string") return command;
  const promptPath = path.resolve(command.rootDir, command.action.promptFile),
    relative = path.relative(command.rootDir, promptPath);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw Object.assign(new Error("--prompt-file must stay within the selected repository."), {
      code: "invalid_field",
    });
  const { promptFile: _promptFile, ...action } = command.action;
  return { ...command, action: { ...action, prompt: readFileSync(promptPath, "utf8") } };
}
