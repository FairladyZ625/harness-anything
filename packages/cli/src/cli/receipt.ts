import type { CliResult } from "./types.ts";
import { cliError, CliErrorCode } from "./error-codes.ts";
import { commandReceiptContractsByKind, type CommandReceiptContract } from "./receipt-contracts.ts";
import {
  commandReceiptEnvelope,
  failureReceiptNextActions,
  type CommandFailureReceipt,
  type CommandReceipt,
  type CommandReceiptEnvelope,
  type CommandReceiptNextAction
} from "@harness-anything/application";

export { commandReceiptEnvelope };
export type { CommandFailureReceipt, CommandReceipt };

const legacyReceiptEnvelope = "CommandReceipt/v1" as const;

interface LegacyCommandReceipt<Command extends string = string> {
  readonly ok: true;
  readonly receipt: typeof legacyReceiptEnvelope;
  readonly command: Command;
  readonly summary: string;
  readonly data?: Record<string, unknown>;
  readonly paths?: Record<string, string>;
  readonly warnings?: ReadonlyArray<unknown>;
  readonly next: ReadonlyArray<CommandReceiptNextAction>;
}

const baseResultKeys = new Set(["ok", "command", "error", "path", "packagePath", "projectionPath", "warnings"]);

type CliFailureResult = CliResult & { readonly ok: false };

export function toCommandReceipt(result: CliResult): CommandReceipt | CommandFailureReceipt {
  if (!result.ok) return failureToReceipt(result as CliFailureResult);

  const raw = result as unknown as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  const paths: Record<string, string> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (baseResultKeys.has(key) || value === undefined) continue;
    data[key] = value;
  }

  setPath(paths, "primary", raw.path);
  setPath(paths, "package", raw.packagePath);
  setPath(paths, "projection", raw.projectionPath);
  classifyPrimaryPath(result.command, paths, raw.path);
  const forceAudit = raw.forceAudit;
  if (forceAudit && typeof forceAudit === "object" && typeof (forceAudit as { path?: unknown }).path === "string") {
    setPath(paths, "forceAudit", (forceAudit as { path: string }).path);
  }
  const warnings = result.warnings ?? [];
  const contract = receiptContractFor(result.command, raw.report);
  const nextResolution = contract
    ? resolveSuccessNext(contract.successNext, raw)
    : { ok: true as const, actions: [] };

  const legacy = {
    ok: true,
    receipt: legacyReceiptEnvelope,
    command: result.command,
    summary: summarizeResult(raw),
    ...(Object.keys(data).length > 0 ? { data } : {}),
    ...(Object.keys(paths).length > 0 ? { paths } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    next: nextResolution.ok ? nextResolution.actions : []
  } satisfies LegacyCommandReceipt;
  const contractViolation = validateReceiptContract(legacy, contract)
    ?? (nextResolution.ok ? undefined : nextResolution.violation);
  if (contractViolation) {
    return failureToReceipt({
      ok: false,
      command: result.command,
      error: cliError(CliErrorCode.CommandReceiptContractMismatch, contractViolation)
    } satisfies CliFailureResult);
  }
  return legacyToV2(legacy);
}

export function renderReceiptText(receipt: CommandReceiptEnvelope): string {
  if (!receipt.ok) return renderFailureReceiptText(receipt);
  if (receipt.command === "completion") return renderCompletionText(receipt);
  if (receipt.command === "capabilities") return renderCapabilitiesText(receipt);
  if (receipt.command === "preset list") return renderPresetListText(receipt);
  if (receipt.command === "doc status") return renderDocStatusText(receipt);
  return renderSuccessReceiptText(receipt);
}

function renderSuccessReceiptText(receipt: CommandReceipt): string {
  const data = receiptDetailsData(receipt);
  const settlement = receipt.settlement;
  const parts = [
    settlement?.canonicalVisibility === "pending"
      ? "pending"
      : settlement?.canonicalVisibility === "failed"
        ? "settlement-failed"
        : "ok",
    `command=${formatToken(receipt.command)}`
  ];
  const rootResolution = receiptRootResolution(receipt.details?.rootResolution);
  if (rootResolution) {
    parts.push(`root=${formatToken(rootResolution.root)}`);
    parts.push(`rootSource=${formatToken(rootResolution.source)}`);
  }
  const taskId = typeof data.taskId === "string" ? data.taskId : receipt.entity?.kind === "task" ? receipt.entity.id : undefined;
  if (typeof taskId === "string") parts.push(`task=${formatToken(taskId)}`);
  const status = typeof data.status === "string" ? data.status : undefined;
  if (typeof status === "string") parts.push(`status=${formatToken(status)}`);
  const primaryPath = receipt.paths?.find((entry) => ["package", "primary", "projection"].includes(entry.role))?.path;
  if (primaryPath) parts.push(`path=${formatToken(primaryPath)}`);
  if (typeof receipt.rows === "number") parts.push(`rows=${receipt.rows}`);
  if (receipt.warnings && receipt.warnings.length > 0) {
    const warning = receiptWarning(
      receipt.warnings.find((value) => receiptWarningCode(value) === "pending_materialization") ?? receipt.warnings[0]
    );
    parts.push(`warnings=${receipt.warnings.length}`);
    if (warning.message) parts.push(`warning=${formatToken(warning.message)}`);
    if (warning.nextCommand) parts.push(`next=${formatToken(warning.nextCommand)}`);
  }
  for (const action of receipt.next) {
    parts.push(`next=${formatToken(action.command)}`);
    if (action.description) parts.push(`nextHint=${formatToken(action.description)}`);
  }
  const mode = launchMode(data.launchPlan);
  if (mode) parts.push(`mode=${formatToken(mode.mode)}`, `package=${formatToken(mode.packageName)}`);
  if (settlement) {
    parts.push(`durability=${formatToken(settlement.durability)}`);
    parts.push(`canonicalVisibility=${formatToken(settlement.canonicalVisibility)}`);
    parts.push(`receiptId=${formatToken(settlement.receiptId)}`);
    parts.push(`status=${formatToken(settlement.statusQuery.command)}`);
  }
  parts.push(`summary=${formatToken(honestSettlementSummary(receipt.summary, settlement?.canonicalVisibility))}`);
  return parts.join(" ");
}

function receiptRootResolution(value: unknown): { readonly root: string; readonly source: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { readonly root?: unknown; readonly source?: unknown };
  return typeof candidate.root === "string" && typeof candidate.source === "string"
    ? { root: candidate.root, source: candidate.source }
    : undefined;
}

function renderCompletionText(receipt: CommandReceipt): string {
  const script = receiptDetailsData(receipt).completionScript;
  return typeof script === "string" ? script : "";
}

function renderFailureReceiptText(receipt: CommandFailureReceipt): string {
  const settlement = receipt.settlement;
  const parts = [
    "error",
    `code=${formatToken(receipt.error?.code ?? "unknown")}`,
    `hint=${formatToken(receipt.error?.hint ?? "Command failed.")}`
  ];
  if (settlement) {
    parts.push(`durability=${formatToken(settlement.durability)}`);
    parts.push(`canonicalVisibility=${formatToken(settlement.canonicalVisibility)}`);
    parts.push(`receiptId=${formatToken(settlement.receiptId)}`);
    parts.push(`status=${formatToken(settlement.statusQuery.command)}`);
    parts.push(`acceptance=${formatToken("One or more writes were durably accepted; query settlement before any replay.")}`);
  } else {
    for (const action of receipt.next ?? []) parts.push(`next=${formatToken(action.command)}`);
  }
  return parts.join(" ");
}

function honestSettlementSummary(
  summary: string,
  visibility: "pending" | "visible" | "failed" | undefined
): string {
  if (visibility !== "pending") return summary;
  return summary
    .replace(/\bcompleted\b/giu, "accepted")
    .replace(/\bcomplete\b/giu, "accepted");
}

function renderPresetListText(receipt: CommandReceipt): string {
  const rows = (receipt.items ?? []).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const preset = item as { readonly id?: unknown; readonly title?: unknown; readonly description?: unknown };
    if (typeof preset.id !== "string") return [];
    const title = typeof preset.title === "string" ? preset.title : preset.id;
    const description = typeof preset.description === "string" ? preset.description : title;
    return [`${preset.id} — ${title} — ${description}`];
  });
  return [rows.length > 0 ? rows.join("\n") : "No presets installed.", renderSuccessReceiptText(receipt)].join("\n");
}

function renderDocStatusText(receipt: CommandReceipt): string {
  const rows = (receipt.items ?? []).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const dirtyFile = item as {
      readonly path?: unknown;
      readonly status?: unknown;
      readonly unresolvedTouches?: unknown;
      readonly forbiddenTouches?: unknown;
    };
    if (typeof dirtyFile.path !== "string") return [];
    const details = [
      ...(Array.isArray(dirtyFile.unresolvedTouches)
        ? dirtyFile.unresolvedTouches.flatMap((touch) => {
          if (!touch || typeof touch !== "object" || Array.isArray(touch)) return [];
          const reason = (touch as { readonly reason?: unknown }).reason;
          return typeof reason === "string" ? [`unresolved: ${reason}`] : [];
        })
        : []),
      ...(Array.isArray(dirtyFile.forbiddenTouches) && dirtyFile.forbiddenTouches.length > 0
        ? [`forbidden touch${dirtyFile.forbiddenTouches.length === 1 ? "" : "s"}`]
        : []),
      ...(dirtyFile.status === "deleted" ? ["deletion"] : [])
    ];
    return [`${dirtyFile.path}${details.length > 0 ? ` — ${details.join("; ")}` : ""}`];
  });
  return [rows.length > 0 ? rows.join("\n") : "No dirty files.", renderSuccessReceiptText(receipt)].join("\n");
}

function receiptWarningCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const code = (value as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function receiptWarning(value: unknown): { readonly message?: string; readonly nextCommand?: string } {
  if (typeof value === "string") return { message: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { message: String(value) };
  const warning = value as { readonly message?: unknown; readonly nextCommand?: unknown };
  return {
    ...(typeof warning.message === "string" ? { message: warning.message } : {}),
    ...(typeof warning.nextCommand === "string" ? { nextCommand: warning.nextCommand } : {})
  };
}

function renderCapabilitiesText(receipt: CommandReceipt): string {
  const kinds = (receipt.items ?? [])
    .map((item) => item && typeof item === "object" && "kind" in item ? String((item as { readonly kind?: unknown }).kind) : "")
    .filter((kind) => kind.length > 0)
    .slice(0, 12)
    .join(",");
  const parts = [`ok`, `command=${formatToken(receipt.command)}`];
  if (typeof receipt.rows === "number") parts.push(`rows=${receipt.rows}`);
  if (kinds.length > 0) parts.push(`kinds=${formatToken(kinds)}`);
  parts.push(`summary=${formatToken(`${receipt.summary}; use --json for full schema, or ha <kind> capabilities --json for one entity.`)}`);
  return parts.join(" ");
}

export function receiptDetailsData(receipt: CommandReceipt): Record<string, unknown> {
  const detailsData = receipt.details?.data;
  return detailsData && typeof detailsData === "object" && !Array.isArray(detailsData) ? detailsData as Record<string, unknown> : {};
}

function legacyToV2(legacy: LegacyCommandReceipt): CommandReceipt {
  const display = displayCommand(legacy.command);
  const data = legacy.data ?? {};
  const report = isReceiptRecord(data.report) ? data.report : undefined;
  const paths = Object.entries(legacy.paths ?? {}).map(([role, path]) => ({ role, path }));
  const rows = typeof data.rows === "number" ? data.rows : typeof report?.rows === "number" ? report.rows as number : undefined;
  const items = itemsFromData(data, report);
  const item = itemFromData(data, report);
  const legacyReport = typeof report?.schema === "string" ? report.schema : undefined;
  return {
    ok: true,
    schema: commandReceiptEnvelope,
    command: display.command,
    entity: entityFromData(display.entity, data),
    action: display.action,
    summary: legacy.summary,
    ...(rows !== undefined ? { rows } : {}),
    ...(item !== undefined ? { item } : {}),
    ...(items ? { items } : {}),
    ...(paths.length > 0 ? { paths } : {}),
    ...(legacy.warnings && legacy.warnings.length > 0 ? { warnings: legacy.warnings } : {}),
    next: legacy.next,
    details: {
      ...(Object.keys(data).length > 0 ? { data } : {}),
      ...(legacy.paths ? { pathsByRole: legacy.paths } : {}),
      ...(report ? { report } : {})
    },
    meta: {
      generatedAt: new Date().toISOString(),
      compatibility: { legacyReceipt: legacyReceiptEnvelope, ...(legacyReport ? { legacyReport } : {}) }
    }
  };
}

function failureToReceipt(result: CliFailureResult): CommandFailureReceipt {
  const display = displayCommand(result.command);
  const raw = result as unknown as Record<string, unknown>;
  const data = Object.fromEntries(Object.entries(raw).filter(([key, value]) =>
    !["ok", "command", "error", "warnings"].includes(key) && value !== undefined
  ));
  const next = failureReceiptNextActions(result.error?.code, data);
  return {
    ok: false,
    schema: commandReceiptEnvelope,
    command: display.command,
    action: display.action,
    summary: result.error?.hint ?? "Command failed.",
    ...(result.error ? { error: result.error } : {}),
    ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    ...(next ? { next } : {}),
    ...(Object.keys(data).length > 0 ? { details: { data } } : {}),
    meta: { generatedAt: new Date().toISOString(), compatibility: { legacyReceipt: legacyReceiptEnvelope } }
  };
}

function setPath(paths: Record<string, string>, key: string, value: unknown): void {
  if (typeof value === "string" && value.length > 0) paths[key] = value;
}

function receiptContractFor(command: string, report: unknown): CommandReceiptContract | undefined {
  const declaredContract: CommandReceiptContract | undefined = commandReceiptContractsByKind[command as keyof typeof commandReceiptContractsByKind];
  if (!declaredContract) return undefined;
  const dryRun = report !== null && typeof report === "object" && !Array.isArray(report)
    && (report as { readonly dryRun?: unknown }).dryRun === true;
  return dryRun && declaredContract.dryRun ? declaredContract.dryRun : declaredContract;
}

function validateReceiptContract(
  receipt: LegacyCommandReceipt,
  contract: CommandReceiptContract | undefined
): string | undefined {
  const declaredContract = commandReceiptContractsByKind[receipt.command as keyof typeof commandReceiptContractsByKind];
  if (!declaredContract) return `missing receipt contract for command ${receipt.command}`;
  if (!contract) return `missing receipt contract for command ${receipt.command}`;
  const allowedData: ReadonlySet<string> = new Set([...contract.data, ...Object.keys(contract.optionalData ?? {})]);
  const allowedPaths: ReadonlySet<string> = new Set([...contract.paths, ...Object.keys(contract.optionalPaths ?? {})]);
  const dataKeys = Object.keys(receipt.data ?? {});
  const pathKeys = Object.keys(receipt.paths ?? {});
  const unexpectedData = dataKeys.filter((key) => !allowedData.has(key));
  const unexpectedPaths = pathKeys.filter((key) => !allowedPaths.has(key));
  const missingData = contract.data.filter((key) => !dataKeys.includes(key));
  const missingPaths = contract.paths.filter((key) => !pathKeys.includes(key));
  const unexpectedViolations = [
    ...unexpectedData.map((key) => `data.${key}`),
    ...unexpectedPaths.map((key) => `paths.${key}`)
  ];
  if (unexpectedViolations.length > 0) {
    return `receipt for command ${receipt.command} emitted undeclared fields: ${unexpectedViolations.join(", ")}`;
  }
  const missingViolations = [
    ...missingData.map((key) => `data.${key}`),
    ...missingPaths.map((key) => `paths.${key}`)
  ];
  return missingViolations.length > 0
    ? `receipt for command ${receipt.command} missed declared fields: ${missingViolations.join(", ")}`
    : undefined;
}

function resolveSuccessNext(
  declaration: CommandReceiptContract["successNext"],
  raw: Readonly<Record<string, unknown>>
): { readonly ok: true; readonly actions: ReadonlyArray<CommandReceiptNextAction> }
  | { readonly ok: false; readonly violation: string } {
  if (declaration.kind === "none") return { ok: true, actions: [] };
  const actions: CommandReceiptNextAction[] = [];
  for (const action of declaration.actions) {
    const command = interpolateSuccessNextTemplate(action.command, raw);
    if (!command.ok) return command;
    const description = interpolateSuccessNextTemplate(action.description, raw);
    if (!description.ok) return description;
    actions.push({ command: command.value, description: description.value });
  }
  return { ok: true, actions };
}

function interpolateSuccessNextTemplate(
  template: string,
  raw: Readonly<Record<string, unknown>>
): { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly violation: string } {
  const fields = [...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)].map((match) => match[1] as string);
  for (const field of fields) {
    const value = raw[field];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return { ok: false, violation: `success next-step template requires missing scalar field ${field}` };
    }
  }
  return {
    ok: true,
    value: template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_placeholder, field: string) => String(raw[field]))
  };
}

function classifyPrimaryPath(command: string, paths: Record<string, string>, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) return;
  const keyByCommand: Record<string, string> = {
    init: "config",
    "progress-append": "progress",
    "task-supersede": "replacement",
    "migrate-run": "session",
    "legacy-intake-plan": "plan",
    "legacy-index": "index",
    "module-scaffold": "modulePlan"
  };
  const key = keyByCommand[command];
  if (key) paths[key] = value;
}

function summarizeResult(raw: Record<string, unknown>): string {
  const command = typeof raw.command === "string" ? raw.command : "unknown";
  const taskId = typeof raw.taskId === "string" ? raw.taskId : undefined;
  const status = typeof raw.status === "string" ? raw.status : undefined;
  const packagePath = typeof raw.packagePath === "string" ? raw.packagePath : undefined;
  const path = typeof raw.path === "string" ? raw.path : undefined;
  const rows = typeof raw.rows === "number" ? raw.rows : undefined;
  const version = typeof raw.version === "string" ? raw.version : undefined;

  if (command === "doc-status") return summarizeDocStatus(raw, rows);
  if (command === "materializer-run") return summarizeMaterializer(raw.report);
  if (command === "new-task" && taskId && packagePath) {
    const report = raw.report;
    const dryRun = report && typeof report === "object" && !Array.isArray(report)
      ? (report as { readonly dryRun?: unknown }).dryRun === true
      : false;
    return dryRun ? `would create task ${taskId} at ${packagePath}` : `created task ${taskId} at ${packagePath}`;
  }
  if (command === "status-set" && taskId && status) return `set task ${taskId} to ${status}`;
  if (command === "progress-append" && taskId) return `appended progress for ${taskId}`;
  if (command === "init" && path) return initSummary(path, raw.report);
  if (command === "version" && version) return `resolved CLI version ${version}`;
  if (command === "help") return "rendered CLI help";
  if (rows !== undefined) return `completed ${displayCommand(command).command} with ${rows} row${rows === 1 ? "" : "s"}`;
  if (taskId) return `completed ${displayCommand(command).command} for ${taskId}`;
  return `completed ${displayCommand(command).command}`;
}

function summarizeDocStatus(raw: Record<string, unknown>, rows: number | undefined): string {
  const report = raw.report;
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return `doc status: ${rows ?? 0} dirty, 0 blocked`;
  }
  const record = report as Record<string, unknown>;
  const blocked = ["forbiddenTouches", "unresolvedTouches", "deletions"]
    .reduce((total, key) => total + (Array.isArray(record[key]) ? record[key].length : 0), 0);
  return `doc status: ${rows ?? 0} dirty, ${blocked} blocked`;
}

function summarizeMaterializer(report: unknown): string {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return "completed materializer run without a report";
  }
  const candidate = report as {
    readonly dryRun?: unknown;
    readonly merged?: unknown;
    readonly branches?: unknown;
  };
  const branches = Array.isArray(candidate.branches) ? candidate.branches : [];
  const failed = branches.filter((branch) => (
    branch && typeof branch === "object" && !Array.isArray(branch) && (branch as { readonly status?: unknown }).status === "conflict"
  ));
  const failedNames = failed.flatMap((branch) => {
    const name = (branch as { readonly branch?: unknown }).branch;
    return typeof name === "string" ? [name] : [];
  });
  if (candidate.dryRun === true) {
    const wouldMerge = branches.filter((branch) => (
      branch && typeof branch === "object" && !Array.isArray(branch) && (branch as { readonly status?: unknown }).status === "would_merge"
    )).length;
    return `Materializer would merge ${wouldMerge} branch${wouldMerge === 1 ? "" : "es"}; failed ${failed.length}${failedNames.length > 0 ? `: ${failedNames.join(", ")}` : ""}.`;
  }
  const merged = typeof candidate.merged === "number" ? candidate.merged : 0;
  return `Materializer merged ${merged} branch${merged === 1 ? "" : "es"}; failed ${failed.length}${failedNames.length > 0 ? `: ${failedNames.join(", ")}` : ""}.`;
}

function initSummary(path: string, report: unknown): string {
  const isolation = report && typeof report === "object" && !Array.isArray(report)
    ? (report as { readonly isolation?: unknown }).isolation
    : undefined;
  const boundary = isolation && typeof isolation === "object" && !Array.isArray(isolation)
    ? (isolation as { readonly boundary?: unknown }).boundary
    : undefined;
  const nextSteps = isolation && typeof isolation === "object" && !Array.isArray(isolation)
    ? (isolation as { readonly nextSteps?: unknown }).nextSteps
    : undefined;
  const summary = typeof boundary === "string"
    ? `initialized harness at ${path}; ${boundary}`
    : `initialized harness at ${path}`;
  const commands = Array.isArray(nextSteps)
    ? nextSteps.filter((step): step is string => typeof step === "string").slice(0, 2)
    : [];
  return commands.length > 0 ? `${summary} Next: ${commands.join("; then ")}.` : summary;
}

export function displayCommand(command: string): { readonly command: string; readonly entity?: string; readonly action: string } {
  const explicit: Record<string, string> = {
    "new-task": "task create",
    "status-set": "task transition",
    "record-fact": "fact record",
    "distill-commit": "distill promote",
    "runtime-event-append": "event append",
    "runtime-event-list": "event list",
    "migrate-plan": "migrate plan",
    "migrate-structure": "migrate structure",
    "migrate-provenance": "migrate provenance",
    "migrate-retired-attribution-fields": "migrate retired-attribution-fields",
    "migrate-run": "migrate run",
    "migrate-verify": "migrate verify",
    "legacy-intake-plan": "legacy plan",
    "legacy-copy-safe-docs": "legacy copy-docs",
    "git-diff": "git diff",
    "module-step": "module step",
    "diagnostics-command-usage": "diagnostics command-usage",
    "worktree-create": "worktree create",
    "worktree-status": "worktree status",
    "entity-list": "entity list",
    capabilities: "capabilities"
  };
  const display = explicit[command] ?? command.replace(/-/gu, " ");
  const [entity, ...rest] = display.split(" ");
  return { command: display, entity, action: rest.join(" ") || entity || display };
}

function entityFromData(kind: string | undefined, data: Record<string, unknown>): { readonly kind: string; readonly id?: string } | undefined {
  if (!kind) return undefined;
  const id = typeof data.decisionId === "string" ? data.decisionId
    : typeof data.taskId === "string" ? data.taskId
      : typeof data.factRef === "string" ? data.factRef
        : undefined;
  return { kind, ...(id ? { id } : {}) };
}

function itemsFromData(data: Record<string, unknown>, report: Record<string, unknown> | undefined): ReadonlyArray<unknown> | undefined {
  for (const key of ["items", "ops", "decisions", "tasks", "templates", "presets", "scripts", "modules", "commands", "dirtyFiles"] as const) {
    const value = report?.[key] ?? data[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function itemFromData(data: Record<string, unknown>, report: Record<string, unknown> | undefined): unknown {
  for (const key of ["item", "decision", "task", "preset", "script", "module", "document"] as const) {
    const value = report?.[key] ?? data[key];
    if (value !== undefined && !Array.isArray(value)) return value;
  }
  const idItem = Object.fromEntries(Object.entries(data).filter(([key]) => ["taskId", "decisionId", "factId", "factRef", "status", "decisionState"].includes(key)));
  return Object.keys(idItem).length > 0 ? idItem : undefined;
}

function isReceiptRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function launchMode(value: unknown): { readonly mode: string; readonly packageName: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { readonly mode?: unknown; readonly packageName?: unknown };
  if (typeof candidate.mode !== "string" || typeof candidate.packageName !== "string") return undefined;
  return { mode: candidate.mode, packageName: candidate.packageName };
}

function formatToken(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/u.test(value) ? value : JSON.stringify(value);
}
