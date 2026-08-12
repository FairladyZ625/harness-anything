import { resolveThinCliCommand, safePath, thinCliCommands, type SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts"; import { parseDocThinCommand } from "./doc-sync-command.ts"; import { parseFactThinCommand } from "./fact-command.ts";
const docThinSyntax = new Set(["--submit", "--execution-id", "--base-ledger-sha", "--path", "--base-blob-sha256"]), factThinSyntax = new Set(["--task", "--statement", "--source", "--observed-at", "--confidence", "--memory-class", "--memory-tag", "--supersedes", "--rationale", "--id"]); export const thinCliLocalErrorCodes = Object.freeze(["daemon_disconnect", "duplicate_field", "invalid_field", "missing_field", "unknown_field", "unsupported_command"]);

export function renderThinHelp(): string { return ["Harness Anything thin CLI", "", "Commands:", ...thinCliCommands.map(({ usage, summary }) => `  ${usage}\n    ${summary}`)].join("\n"); }

export interface ThinCommand {
  readonly rootDir: SafePath;
  readonly repoId?: string;
  readonly json: boolean;
  readonly method: string;
  readonly action: Readonly<Record<string, unknown>> & { readonly kind: string };
}
export type ThinParseResult = { readonly ok: true; readonly command: ThinCommand }
  | { readonly ok: false; readonly code: string; readonly nextAction: string; readonly json: boolean };

export function parseThinCommand(argv: readonly string[], cwd = process.cwd()): ThinParseResult {
  const rootDir = safePath(globalOption(argv, "--root") ?? cwd), repoId = globalOption(argv, "--repo"), json = argv.includes("--json");
  const args = stripGlobals(argv), route = resolveThinCliCommand(args);
  if (route?.id === "repo-bootstrap") {
    const flags = readFlags(args.slice(1), new Set(["--repo-id", "--person-id", "--display-name"]), new Set());
    if (!flags.ok) return rejected(flags.code, flags.nextAction, json);
    const initRepoId = flags.one.get("--repo-id"), personId = flags.one.get("--person-id"), displayName = flags.one.get("--display-name");
    if (!nonEmpty(initRepoId) || !nonEmpty(personId) || !nonEmpty(displayName)) return rejected("missing_field", "Init requires repo-id, person-id, and display-name.", json);
    return accepted(rootDir, undefined, json, { kind: "repo-bootstrap", repoId: initRepoId, personId, displayName });
  }
  if (route?.id === "receipt-show" && nonEmpty(args[2]) && args.length === 3) {
    return accepted(rootDir, repoId, json, { kind: "receipt-show", opId: args[2] });
  }
  if (route?.id.startsWith("doc-")) return parseDocThinCommand(route.id, args, rootDir, repoId, json, docThinSyntax); if (route?.id.startsWith("fact-")) return parseFactThinCommand(route.id, args, rootDir, repoId, json, factThinSyntax);
  if (route?.phase.startsWith("Preset-") && "flags" in route) { const positionalField = "positional" in route ? route.positional : undefined, positionalFields = "positionalFields" in route ? route.positionalFields : undefined, positional = positionalField ? args[route.path.length] : undefined, offset = route.path.length + (positionalField ? 1 : 0), flags = readFlags(args.slice(offset), new Set(route.flags.map(({ name }) => name)), new Set()); if (!flags.ok) return rejected(flags.code, flags.nextAction, json); if (positionalField && !nonEmpty(positional)) return rejected("missing_field", `${positionalField} is required.`, json); const matched = positionalFields && positional ? /^preset:([a-z0-9][a-z0-9-]{0,127})\/([A-Za-z0-9._-]+)$/u.exec(positional) : null; if (positionalFields && !matched) return rejected("invalid_field", "Use preset:<id>/<entrypoint>.", json); let payload: Record<string, unknown>; try { payload = Object.fromEntries(route.flags.flatMap((flag) => { const value = flags.one.get(flag.name); return value ? [[flag.field, "codec" in flag && flag.codec === "json" ? JSON.parse(value) : value]] : []; })); } catch { return rejected("invalid_field", "--inputs must be a JSON object.", json); } for (const flag of route.flags) if ("required" in flag && flag.required && !payload[flag.field]) return rejected("missing_field", `${flag.name} is required.`, json); const position = matched && positionalFields ? { [positionalFields[0]]: matched[1], [positionalFields[1]]: matched[2] } : positionalField ? { [positionalField]: positional } : {}; return accepted(rootDir, repoId, json, { kind: route.id, ...position, ...payload }, route.method); }
  if (!route || args[0] !== "task") return rejected("unsupported_command", "Only task lifecycle, receipt show, and explicit daemon commands exist on rebuild.", json);
  const verb = args[1];
  if (route.id === "task-show" && nonEmpty(args[2]) && args.length === 3) return accepted(rootDir, repoId, json, { kind: "task-show", verb, taskId: args[2] });
  const taskId = args[2];
  if (!nonEmpty(taskId)) return rejected("missing_field", `Run ha task ${verb ?? "<verb>"} <task-id>.`, json);
  if (route.id === "task-start") return oneExecution(rootDir, repoId, json, args, taskId, "task-start", "StartExecution");
  if (route.id === "task-submit") {
    const flags = readFlags(args.slice(3), new Set(["--execution-id", "--claim", "--commit-sha"]),
      new Set(["--deliverable", "--evidence-ref", "--verification", "--known-gap", "--residual-risk"]));
    if (!flags.ok) return rejected(flags.code, flags.nextAction, json);
    const executionId = flags.one.get("--execution-id"), claim = flags.one.get("--claim"), commitSha = flags.one.get("--commit-sha");
    if (!nonEmpty(executionId) || !nonEmpty(claim) || !commitSha?.match(/^[0-9a-f]{40}$/u)) return rejected("invalid_field", "Submit requires execution-id, claim, and a 40-character commit-sha.", json);
    return accepted(rootDir, repoId, json, { kind: "task-submit", verb, commandType: "SubmitExecution", taskId, executionId, claim, commitSha,
      deliverables: flags.many.get("--deliverable") ?? [], evidenceRefs: flags.many.get("--evidence-ref") ?? [], verification: flags.many.get("--verification") ?? [],
      knownGaps: flags.many.get("--known-gap") ?? [], residualRisks: flags.many.get("--residual-risk") ?? [] });
  }
  if (route.id === "task-review-execution") return parseReviewCommand(rootDir, repoId, json, args, taskId);
  if (route.id === "task-complete") return oneExecution(rootDir, repoId, json, args, taskId, "task-complete", "CompleteTask", "--gate-receipt");
  return rejected("unsupported_command", "Use task create, start, submit, review-execution, complete, or show.", json);
}

function parseReviewCommand(rootDir: SafePath, repoId: string | undefined, json: boolean, args: readonly string[], taskId: string): ThinParseResult {
  const flags = readFlags(args.slice(3), new Set(["--execution-id", "--kind", "--verdict", "--review-id", "--reason", "--commit-sha", "--iteration"]),
    new Set(["--evidence-checked"]), new Set(["--acknowledge-archive-warnings"]));
  if (!flags.ok) return rejected(flags.code, flags.nextAction, json);
  const executionId = flags.one.get("--execution-id"), reviewKind = flags.one.get("--kind"), verdict = flags.one.get("--verdict"),
    reviewId = flags.one.get("--review-id"), reason = flags.one.get("--reason"), commitSha = flags.one.get("--commit-sha"), round = Number(flags.one.get("--iteration"));
  if (!nonEmpty(executionId) || !["anti_entropy", "acceptance"].includes(reviewKind ?? "") || !["approved", "changes_requested", "dismissed"].includes(verdict ?? "")
    || !nonEmpty(reviewId) || !nonEmpty(reason) || !commitSha?.match(/^[0-9a-f]{40}$/u) || (round !== 0 && round !== 1)) {
    return rejected("invalid_field", "Review requires execution-id, kind, verdict, review-id, reason, commit-sha, and iteration 0|1.", json);
  }
  return accepted(rootDir, repoId, json, { kind: "task-review-execution", verb: args[1], commandType: "RecordReview", taskId, executionId,
    reviewKind, verdict, reviewId, reason, commitSha, iteration: round, evidenceChecked: flags.many.get("--evidence-checked") ?? [],
    archiveWarningsAcknowledged: flags.booleans.has("--acknowledge-archive-warnings") });
}

function oneExecution(rootDir: SafePath, repoId: string | undefined, json: boolean, args: readonly string[], taskId: string,
  kind: string, commandType: string, repeated?: string): ThinParseResult {
  const flags = readFlags(args.slice(3), new Set(["--execution-id"]), repeated ? new Set([repeated]) : new Set());
  if (!flags.ok) return rejected(flags.code, flags.nextAction, json);
  const executionId = flags.one.get("--execution-id");
  if (!nonEmpty(executionId)) return rejected("missing_field", "Add --execution-id <execution-id>.", json);
  const gateReceipts: { readonly gateId: string; readonly receiptRef: string }[] = [];
  if (repeated) for (const value of flags.many.get(repeated) ?? []) { const parsed = splitGateReceipt(value);
    if (!parsed) return rejected("invalid_field", "Use --gate-receipt <gate-id>:<receipt-ref>.", json); gateReceipts.push(parsed); }
  return accepted(rootDir, repoId, json, { kind, verb: args[1], commandType, taskId, executionId, ...(repeated ? { gateReceipts } : {}) });
}
function splitGateReceipt(value: string): { readonly gateId: string; readonly receiptRef: string } | undefined { const at = value.indexOf(":");
  return at < 1 || at === value.length - 1 ? undefined : { gateId: value.slice(0, at), receiptRef: value.slice(at + 1) }; }
function accepted(rootDir: SafePath, repoId: string | undefined, json: boolean, action: ThinCommand["action"], method = "repo.task.run"): ThinParseResult {
  return { ok: true, command: { rootDir, ...(repoId ? { repoId } : {}), json, method, action } };
}
function rejected(code: string, nextAction: string, json: boolean): ThinParseResult { return { ok: false, code, nextAction, json }; }
function globalOption(argv: readonly string[], name: string): string | undefined { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; }
function stripGlobals(argv: readonly string[]): string[] { return argv.filter((value, index) => value !== "--json" && !["--root", "--repo"].includes(value)
  && !["--root", "--repo"].includes(argv[index - 1] ?? "")); }
function nonEmpty(value: string | undefined): value is string { return typeof value === "string" && value.trim().length > 0; }
function readFlags(tokens: readonly string[], singles: ReadonlySet<string>, repeated: ReadonlySet<string>, booleans: ReadonlySet<string> = new Set()): { readonly ok: true; readonly one: Map<string, string>; readonly many: Map<string, string[]>; readonly booleans: Set<string> }
  | { readonly ok: false; readonly code: string; readonly nextAction: string } {
  const one = new Map<string, string>(), many = new Map<string, string[]>(), flags = new Set<string>();
  for (let index = 0; index < tokens.length;) { const name = tokens[index];
    if (name && booleans.has(name)) { if (flags.has(name)) return { ok: false, code: "duplicate_field", nextAction: `${name} may appear once.` }; flags.add(name); index += 1; continue; }
    const value = tokens[index + 1];
    if (!name || (!singles.has(name) && !repeated.has(name))) return { ok: false, code: "unknown_field", nextAction: `Unknown option ${name ?? "<missing>"}.` };
    if (!nonEmpty(value) || value.startsWith("--")) return { ok: false, code: "missing_field", nextAction: `${name} requires a value.` };
    if (singles.has(name)) { if (one.has(name)) return { ok: false, code: "duplicate_field", nextAction: `${name} may appear once.` }; one.set(name, value); }
    else many.set(name, [...many.get(name) ?? [], value]);
    index += 2;
  }
  return { ok: true, one, many, booleans: flags };
}
