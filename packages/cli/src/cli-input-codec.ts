import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { CliInputFacet, CliPositionalInputFacet } from "@harness-anything/preset/internal/preset-command-contract";
import { cliErrorMessage } from "./cli-error.ts";

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "invalid_field" });
}

/** The file-codec IO port shared by local parsing, local execution and Fleet forwarding. */
export function readCliInputFile(
  rootDir: string,
  source: string,
  input: Pick<CliInputFacet | CliPositionalInputFacet, "name" | "pathKind" | "codec">,
): string {
  const codec = input.codec,
    label = input.name;
  if (!codec || typeof codec !== "object" || (codec.kind === "json-object" && codec.source !== "file"))
    invalid(`${label} must declare a file codec.`);
  if (typeof source !== "string" || source.length === 0) invalid(`${label} must name one file on this edge.`);
  let resolved: string;
  try {
    const root = realpathSync.native(rootDir),
      requested = path.resolve(root, source);
    const requireInside = (candidate: string) => {
      const relative = path.relative(root, candidate);
      if (
        input.pathKind === "workspace-file" &&
        (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      )
        invalid(`${label} must stay within the selected repository.`);
    };
    if (!path.isAbsolute(source)) requireInside(requested);
    const parent = realpathSync.native(path.dirname(requested));
    requireInside(parent);
    resolved = realpathSync.native(path.join(parent, path.basename(requested)));
    requireInside(resolved);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "invalid_field") throw error;
    throw Object.assign(new Error(`${label} could not be resolved on this edge: ${cliErrorMessage(error)}`), {
      code: "invalid_field",
      cause: error,
    });
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolved);
  } catch (error) {
    throw Object.assign(new Error(`${label} could not be read on this edge: ${cliErrorMessage(error)}`), {
      code: "invalid_field",
      cause: error,
    });
  }
  if (bytes.byteLength > codec.maxBytes) invalid(`${label} exceeds the declared ${codec.maxBytes}-byte limit.`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw Object.assign(new Error(`${label} must be valid UTF-8.`), { code: "invalid_field", cause: error });
  }
}
