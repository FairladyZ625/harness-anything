import type { CommandRegistryEntry } from "../types.ts";
import { generateBashCompletion } from "./bash.ts";
import { deriveShellCompletionModel } from "./model.ts";
import { generateZshCompletion } from "./zsh.ts";

export type CompletionShell = "bash" | "zsh";

export function generateShellCompletion(
  shell: CompletionShell,
  registry: ReadonlyArray<CommandRegistryEntry>
): string {
  const model = deriveShellCompletionModel(registry);
  return shell === "bash" ? generateBashCompletion(model) : generateZshCompletion(model);
}
