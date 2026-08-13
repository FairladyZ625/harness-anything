import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import type { ThinParseResult } from "./thin-command.ts";

export function parseFactThinCommand(id: string, args: readonly string[], rootDir: SafePath, repoId: string | undefined, json: boolean): ThinParseResult { if (id === "fact-record") return record(args, rootDir, repoId, json);
  if (id === "fact-search") return search(args, rootDir, repoId, json);
  if (id === "fact-show") return show(args, rootDir, repoId, json);
  return reject("unsupported_command", "Use fact record, search, or show.", json);
}
function record(args: readonly string[], rootDir: SafePath, repoId: string | undefined, json: boolean): ThinParseResult {
  const flags = flagsOf(args.slice(2), ["--task", "--statement", "--source", "--observed-at", "--confidence", "--memory-class", "--supersedes", "--rationale"], ["--memory-tag"]);
  if (!flags.ok) return reject(flags.code, flags.nextAction, json);
  const taskId = flags.one.get("--task"), statement = flags.one.get("--statement"), evidenceSource = flags.one.get("--source"), observedAt = flags.one.get("--observed-at"),
    confidence = flags.one.get("--confidence") ?? "medium", memoryClass = flags.one.get("--memory-class") ?? "episodic", supersedes = flags.one.get("--supersedes"), rationale = flags.one.get("--rationale");
  if (!text(taskId) || !text(statement) || !text(evidenceSource)) return reject("missing_field", "Fact record requires --task, --statement, and --source.", json);
  if (!(["low", "medium", "high"] as const).includes(confidence as never) || !(["semantic", "episodic", "procedural"] as const).includes(memoryClass as never)
    || observedAt !== undefined && !Number.isFinite(Date.parse(observedAt)) || Boolean(supersedes) !== Boolean(rationale) || rationale !== undefined && [...rationale].length > 199) return reject("invalid_field", "Use valid confidence/memory values and pair --supersedes with a rationale of at most 199 characters.", json);
  return accept(rootDir, repoId, json, { kind: "fact-record", taskId, statement, evidenceSource, ...(observedAt ? { observedAt } : {}), confidence, memoryClass,
    memoryTags: flags.many.get("--memory-tag") ?? [], ...(supersedes && rationale ? { supersedes: { factRef: supersedes, rationale } } : {}) });
}
function search(args: readonly string[], rootDir: SafePath, repoId: string | undefined, json: boolean): ThinParseResult {
  const query = args[2]?.startsWith("--") ? undefined : args[2], flags = flagsOf(args.slice(query ? 3 : 2), ["--task", "--confidence", "--memory-class"], []);
  if (!flags.ok) return reject(flags.code, flags.nextAction, json);
  const confidence = flags.one.get("--confidence"), memoryClass = flags.one.get("--memory-class");
  if (confidence && !["low", "medium", "high"].includes(confidence) || memoryClass && !["semantic", "episodic", "procedural"].includes(memoryClass)) return reject("invalid_field", "Fact search filters are invalid.", json);
  return accept(rootDir, repoId, json, { kind: "fact-search", ...(query ? { query } : {}), ...(flags.one.get("--task") ? { taskId: flags.one.get("--task") } : {}), ...(confidence ? { confidence } : {}), ...(memoryClass ? { memoryClass } : {}) });
}
function show(args: readonly string[], rootDir: SafePath, repoId: string | undefined, json: boolean): ThinParseResult {
  const flags = flagsOf(args.slice(2), ["--task", "--id"], []); if (!flags.ok) return reject(flags.code, flags.nextAction, json);
  const taskId = flags.one.get("--task"), factId = flags.one.get("--id"); if (!text(taskId) || !text(factId)) return reject("missing_field", "Fact show requires --task and --id.", json);
  if (!/^F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(factId)) return reject("invalid_field", "Fact id must use F- plus eight Crockford characters.", json);
  return accept(rootDir, repoId, json, { kind: "fact-show", taskId, factId });
}
function flagsOf(tokens: readonly string[], singles: readonly string[], repeated: readonly string[]): { readonly ok: true; readonly one: Map<string, string>; readonly many: Map<string, string[]> } | { readonly ok: false; readonly code: string; readonly nextAction: string } {
  const one = new Map<string, string>(), many = new Map<string, string[]>();
  for (let at = 0; at < tokens.length; at += 2) { const name = tokens[at], value = tokens[at + 1];
    if (!name || !singles.includes(name) && !repeated.includes(name)) return { ok: false, code: "unknown_field", nextAction: `Unknown option ${name ?? "<missing>"}.` };
    if (!text(value) || value.startsWith("--")) return { ok: false, code: "missing_field", nextAction: `${name} requires a value.` };
    if (singles.includes(name)) { if (one.has(name)) return { ok: false, code: "duplicate_field", nextAction: `${name} may appear once.` }; one.set(name, value); }
    else many.set(name, [...many.get(name) ?? [], value]);
  } return { ok: true, one, many };
}
function accept(rootDir: SafePath, repoId: string | undefined, json: boolean, action: Readonly<Record<string, unknown>> & { readonly kind: string }): ThinParseResult { return { ok: true, command: { rootDir, ...(repoId ? { repoId } : {}), json, method: "repo.task.run", action } }; }
function reject(code: string, nextAction: string, json: boolean): ThinParseResult { return { ok: false, code, nextAction, json }; }
function text(value: string | undefined): value is string { return typeof value === "string" && value.trim().length > 0; }
