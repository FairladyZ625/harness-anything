import { readFileSync } from "node:fs";
import path from "node:path";
import type { ThinCommand } from "./cli/thin-command.ts";

/**
 * `ha task artifact add --source` names a file on the caller's machine. The daemon only reads path
 * sources inside the repository, so a caller's scratchpad would otherwise be refused as an escape.
 * A UTF-8 text source outside the repository rides the same inline `content` channel `--run`
 * already uses: the CLI reads it, the daemon validates and publishes it, and the CLI writes
 * nothing locally. Binary sources stay on the path channel and must live inside the repository.
 */
export function materializeArtifactSource(command: ThinCommand): ThinCommand {
  if (command.action.kind !== "task-artifact-add" || typeof command.action.source !== "string") return command;
  const source = command.action.source,
    absolute = path.resolve(command.rootDir, source),
    relative = path.relative(command.rootDir, absolute);
  if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return command;
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch (error) {
    throw Object.assign(
      new Error(`artifact source must be an existing readable file: ${source} (${(error as Error).message})`),
      { code: "artifact_source_missing" },
    );
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw Object.assign(
      new Error(
        `artifact source outside the repository must be UTF-8 text: ${source}. ` +
          "Place a binary artifact inside the repository and retry with --source.",
      ),
      { code: "artifact_source_invalid" },
    );
  }
  const { source: _source, ...action } = command.action;
  return { ...command, action: { ...action, content } };
}
