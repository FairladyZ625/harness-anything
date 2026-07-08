import { parseEntityRef, relationTypes, type RelationType } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand, RelationListFilters } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseRelationArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] !== "relation" || args[1] !== "list") return null;

  const entity = readRelationRef(args, "--entity");
  if (!entity.ok) return { ok: false, error: entity.error };
  const source = readRelationRef(args, "--source");
  if (!source.ok) return { ok: false, error: source.error };
  const target = readRelationRef(args, "--target");
  if (!target.ok) return { ok: false, error: target.error };
  const relationType = readRelationType(readOption(args, "--type"));
  if (!relationType.ok) return { ok: false, error: relationType.error };
  const state = readRelationState(readOption(args, "--state"));
  if (!state.ok) return { ok: false, error: state.error };

  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "relation-list",
        filters: {
          ...(entity.value ? { entity: entity.value } : {}),
          ...(source.value ? { source: source.value } : {}),
          ...(target.value ? { target: target.value } : {}),
          ...(relationType.value ? { type: relationType.value } : {}),
          ...(state.value ? { state: state.value } : {})
        } satisfies RelationListFilters
      }
    }
  };
}

function readRelationRef(
  args: ReadonlyArray<string>,
  flag: "--entity" | "--source" | "--target"
): { readonly ok: true; readonly value?: string } | { readonly ok: false; readonly error: NonNullable<CliResult["error"]> } {
  const value = readOption(args, flag);
  if (!value) return { ok: true };
  const parsed = parseEntityRef(value);
  if (!parsed || parsed.externalHarness) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionEvidenceRelation, `${flag} must be a local task/<id>, decision/<id>, or fact/<task-id>/<fact-id> ref.`) };
  }
  return { ok: true, value };
}

function readRelationType(value: string | undefined):
  | { readonly ok: true; readonly value?: RelationType }
  | { readonly ok: false; readonly error: NonNullable<CliResult["error"]> } {
  if (!value) return { ok: true };
  if ((relationTypes as ReadonlyArray<string>).includes(value)) return { ok: true, value: value as RelationType };
  return {
    ok: false,
    error: cliError(CliErrorCode.InvalidDecisionEvidenceRelation, `Invalid relation type: ${value}. Valid relation types: ${relationTypes.join(", ")}.`)
  };
}

function readRelationState(value: string | undefined):
  | { readonly ok: true; readonly value?: "active" | "retired" }
  | { readonly ok: false; readonly error: NonNullable<CliResult["error"]> } {
  if (!value) return { ok: true };
  if (value === "active" || value === "retired") return { ok: true, value };
  return { ok: false, error: cliError(CliErrorCode.InvalidStatus, "Use --state active or --state retired for relation list.") };
}
