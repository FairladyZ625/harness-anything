import type { CliResult } from "./types.ts";

export const commandReceiptEnvelope = "CommandReceipt/v1" as const;

export interface CommandReceipt<Command extends string = string> {
  readonly ok: true;
  readonly receipt: typeof commandReceiptEnvelope;
  readonly command: Command;
  readonly summary: string;
  readonly data?: Record<string, unknown>;
  readonly paths?: Record<string, string>;
  readonly write?: CommandReceiptWrite;
  readonly warnings?: ReadonlyArray<unknown>;
  readonly next?: ReadonlyArray<string>;
}

export interface CommandReceiptWrite {
  readonly opId?: string;
  readonly committed?: boolean;
  readonly paths?: ReadonlyArray<string>;
}

interface CommandReceiptContract {
  readonly kind: string;
  readonly data: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string>;
}

export const commandReceiptContracts = [
  { kind: "help", data: ["commands", "report"], paths: [] },
  { kind: "init", data: ["generated"], paths: ["primary", "config"] },
  { kind: "new-task", data: ["taskId", "slug", "status", "preset", "module", "generated", "report"], paths: ["package"] },
  { kind: "status-set", data: ["taskId", "status", "forced", "forceAudit"], paths: ["forceAudit"] },
  { kind: "progress-append", data: ["taskId", "report"], paths: ["primary", "progress"] },
  { kind: "task-archive", data: ["taskId", "status", "report"], paths: [] },
  { kind: "task-supersede", data: ["taskId", "status", "report"], paths: ["primary", "package"] },
  { kind: "task-delete", data: ["taskId", "mode", "report"], paths: [] },
  { kind: "task-reopen", data: ["taskId", "status", "report"], paths: [] },
  { kind: "task-review", data: ["taskId", "reviewContract", "report"], paths: [] },
  { kind: "task-complete", data: ["taskId", "status", "completionGate", "report"], paths: [] },
  { kind: "template-list", data: ["templates"], paths: [] },
  { kind: "template-render", data: ["document"], paths: [] },
  { kind: "task-list", data: ["tasks", "rows"], paths: [] },
  { kind: "status", data: ["rows", "summary", "report", "commands"], paths: ["projection"] },
  { kind: "check", data: ["profile", "rows", "summary", "report"], paths: ["projection"] },
  { kind: "governance-rebuild", data: ["mode", "rows", "generated", "report"], paths: ["projection"] },
  { kind: "lesson-promote", data: ["taskId", "mode", "report"], paths: [] },
  { kind: "lesson-sediment", data: ["taskId", "mode", "report"], paths: [] },
  { kind: "adopt-multica", data: ["taskId", "status", "report"], paths: [] },
  { kind: "snapshot-multica", data: ["report"], paths: [] },
  { kind: "migrate-plan", data: ["rows", "report"], paths: [] },
  { kind: "migrate-structure", data: ["mode", "report"], paths: [] },
  { kind: "migrate-run", data: ["migrationMode", "report"], paths: ["primary", "session"] },
  { kind: "migrate-verify", data: ["report"], paths: [] },
  { kind: "legacy-scan", data: ["report"], paths: [] },
  { kind: "legacy-intake-plan", data: ["report"], paths: ["primary", "plan"] },
  { kind: "legacy-copy-safe-docs", data: ["report"], paths: [] },
  { kind: "legacy-index", data: ["summary", "report"], paths: ["primary", "index"] },
  { kind: "legacy-verify", data: ["report"], paths: [] },
  { kind: "git-diff", data: ["report"], paths: [] },
  { kind: "doctor", data: ["report"], paths: [] },
  { kind: "preset-validate", data: ["preset", "report"], paths: [] },
  { kind: "preset-list", data: ["presets"], paths: [] },
  { kind: "preset-inspect", data: ["preset"], paths: [] },
  { kind: "preset-check", data: ["preset", "report"], paths: [] },
  { kind: "preset-install", data: ["preset", "report"], paths: [] },
  { kind: "preset-seed", data: ["presets", "report"], paths: [] },
  { kind: "preset-audit", data: ["presets", "report"], paths: [] },
  { kind: "preset-uninstall", data: ["preset", "report"], paths: [] },
  { kind: "preset-run", data: ["taskId", "preset", "generated", "report"], paths: [] },
  { kind: "preset-action", data: ["taskId", "preset", "generated", "report"], paths: [] },
  { kind: "module-list", data: ["modules"], paths: [] },
  { kind: "module-inspect", data: ["module"], paths: [] },
  { kind: "module-register", data: ["module"], paths: [] },
  { kind: "module-scaffold", data: ["module"], paths: ["primary", "modulePlan"] },
  { kind: "module-unregister", data: ["module"], paths: [] },
  { kind: "module-step", data: ["module"], paths: [] },
  { kind: "vertical-validate", data: ["report"], paths: [] },
  { kind: "gui", data: ["launchPlan"], paths: [] },
  { kind: "version", data: ["version"], paths: [] }
] as const satisfies ReadonlyArray<CommandReceiptContract>;

const baseResultKeys = new Set(["ok", "command", "error", "path", "packagePath", "projectionPath", "warnings"]);

type CliFailureResult = CliResult & { readonly ok: false };

export function toCommandReceipt(result: CliResult): CommandReceipt | CliFailureResult {
  if (!result.ok) return result as CliFailureResult;

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

  return {
    ok: true,
    receipt: commandReceiptEnvelope,
    command: result.command,
    summary: summarizeResult(raw),
    ...(Object.keys(data).length > 0 ? { data } : {}),
    ...(Object.keys(paths).length > 0 ? { paths } : {}),
    ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {})
  };
}

export function renderReceiptText(receipt: CommandReceipt): string {
  const parts = [`ok`, `command=${formatToken(receipt.command)}`];
  const taskId = receipt.data?.taskId;
  if (typeof taskId === "string") parts.push(`task=${formatToken(taskId)}`);
  const status = receipt.data?.status;
  if (typeof status === "string") parts.push(`status=${formatToken(status)}`);
  const primaryPath = receipt.paths?.package ?? receipt.paths?.primary ?? receipt.paths?.projection;
  if (primaryPath) parts.push(`path=${formatToken(primaryPath)}`);
  const rows = receipt.data?.rows;
  if (typeof rows === "number") parts.push(`rows=${rows}`);
  const mode = launchMode(receipt.data?.launchPlan);
  if (mode) parts.push(`mode=${formatToken(mode.mode)}`, `package=${formatToken(mode.packageName)}`);
  parts.push(`summary=${formatToken(receipt.summary)}`);
  return parts.join(" ");
}

function setPath(paths: Record<string, string>, key: string, value: unknown): void {
  if (typeof value === "string" && value.length > 0) paths[key] = value;
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

  if (command === "new-task" && taskId && packagePath) return `created task ${taskId} at ${packagePath}`;
  if (command === "status-set" && taskId && status) return `set task ${taskId} to ${status}`;
  if (command === "progress-append" && taskId) return `appended progress for ${taskId}`;
  if (command === "init" && path) return `initialized harness at ${path}`;
  if (command === "version" && version) return `resolved CLI version ${version}`;
  if (command === "help") return "rendered CLI help";
  if (rows !== undefined) return `completed ${command} with ${rows} row${rows === 1 ? "" : "s"}`;
  if (taskId) return `completed ${command} for ${taskId}`;
  return `completed ${command}`;
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
