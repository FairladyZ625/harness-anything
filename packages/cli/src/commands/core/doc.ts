import { Effect } from "effect";
import { buildDocmapReadSet, filterDocmapDocuments, readDocmapManifest } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

type DocAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "doc-list" | "doc-map" }>;

export const runDocCommand: CommandRunner = (context, command) => Effect.sync(() => {
  const action = command.action as DocAction;
  try {
    const result = readDocmapManifest(context.layoutInput);
    if (action.kind === "doc-list") {
      const docs = filterDocmapDocuments(result.manifest, action.filters);
      return {
        ok: true,
        command: "doc-list",
        rows: docs.length,
        path: result.relativePath,
        report: {
          schema: "docmap-cli-report/v1",
          manifest: result.relativePath,
          filters: action.filters,
          documents: docs
        }
      } satisfies CliResult;
    }
    const readSet = buildDocmapReadSet(result.manifest, action.filters);
    return {
      ok: true,
      command: "doc-map",
      rows: readSet.mandatory.length + readSet.recommended.length,
      path: result.relativePath,
      report: {
        schema: "docmap-cli-report/v1",
        manifest: result.relativePath,
        filters: action.filters,
        readSet
      }
    } satisfies CliResult;
  } catch (error) {
    return {
      ok: false,
      command: action.kind,
      error: cliError(CliErrorCode.DocmapInvalid, error instanceof Error ? error.message : "Docmap manifest is invalid.")
    } satisfies CliResult;
  }
});
