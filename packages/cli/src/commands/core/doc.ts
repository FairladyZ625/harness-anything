import { Effect } from "effect";
import { buildDocmapReadSet, filterDocmapDocuments, readDocmapManifest } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { deriveDocmapManifest, writeDerivedDocmapManifest } from "./docmap-generate.ts";

type DocAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "doc-list" | "doc-map" | "doc-generate" }>;

export const runDocCommand: CommandRunner = (context, command) => Effect.gen(function* () {
  const action = command.action as DocAction;
  try {
    if (action.kind === "doc-generate") {
      const result = action.write
        ? yield* writeDerivedDocmapManifest(context.layoutInput, context.makeWriteCoordinator({ kind: "agent", id: "docmap-generate" }))
        : deriveDocmapManifest(context.layoutInput);
      const docs = filterDocmapDocuments(result.manifest, action.filters);
      return {
        ok: true,
        command: "doc-generate",
        rows: docs.length,
        path: result.relativePath,
        report: {
          schema: "docmap-generate-report/v1",
          manifest: result.relativePath,
          write: action.write,
          filters: action.filters,
          documents: docs,
          ...(action.write ? { git: { committed: true, coordinator: "write-journal" } } : {})
        }
      } satisfies CliResult;
    }
    const result = readDocmapManifest(context.layoutInput, context.artifactStore);
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
