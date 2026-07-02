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
