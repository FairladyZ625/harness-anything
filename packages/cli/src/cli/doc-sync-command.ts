import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import type { ThinParseResult } from "./thin-command.ts";

export function parseDocThinCommand(routeId: string, args: readonly string[], rootDir: SafePath, repoId: string | undefined, json: boolean, syntax: ReadonlySet<string>): ThinParseResult {
  const offset = routeId === "doc-sync-submit" ? 3 : 2, parsed = flags(args.slice(offset), syntax);
  if (!parsed.ok) return { ...parsed, json };
  const path = parsed.values.get("--path"); if (!path) return failure("missing_field", "Add --path <authored-relative-path>.", json);
  if (routeId === "doc-status" && only(parsed.values, ["--path"])) return accepted(rootDir, repoId, json, { kind: "doc-status", paths: [path] });
  if (routeId === "doc-show" && only(parsed.values, ["--path"])) return accepted(rootDir, repoId, json, { kind: "doc-show", path });
  if (routeId !== "doc-sync-submit" || !only(parsed.values, ["--path", "--execution-id", "--base-ledger-sha", "--base-blob-sha256"])) return failure("unknown_field", "Use only the contracted doc command fields.", json);
  const executionId = parsed.values.get("--execution-id"), baseLedgerSha = parsed.values.get("--base-ledger-sha");
  if (!executionId || !baseLedgerSha) return failure("missing_field", "Doc submit requires execution-id, base-ledger-sha, and path.", json);
  return accepted(rootDir, repoId, json, { kind: "doc-submit", executionId, baseLedgerSha,
    selections: [{ path, baseBlobSha256: parsed.values.get("--base-blob-sha256") ?? null }] });
}
function flags(tokens: readonly string[], syntax: ReadonlySet<string>): { readonly ok: true; readonly values: Map<string, string> } | { readonly ok: false; readonly code: string; readonly nextAction: string } {
  const values = new Map<string, string>(); for (let index = 0; index < tokens.length; index += 2) { const name = tokens[index], value = tokens[index + 1];
    if (!name?.startsWith("--") || !syntax.has(name)) return { ok: false, code: "unknown_field", nextAction: `Unknown option ${name ?? "<missing>"}.` };
    if (!value || value.startsWith("--")) return { ok: false, code: "missing_field", nextAction: `${name} requires a value.` };
    if (values.has(name)) return { ok: false, code: "duplicate_field", nextAction: `${name} may appear once.` }; values.set(name, value); }
  return { ok: true, values };
}
function only(values: ReadonlyMap<string, string>, allowed: readonly string[]): boolean { return [...values.keys()].every((key) => allowed.includes(key)); }
function accepted(rootDir: SafePath, repoId: string | undefined, json: boolean, action: { readonly kind: string } & Readonly<Record<string, unknown>>): ThinParseResult { return { ok: true, command: { rootDir, ...(repoId ? { repoId } : {}), json, action } }; }
function failure(code: string, nextAction: string, json: boolean): ThinParseResult { return { ok: false, code, nextAction, json }; }
