import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, resolveHarnessLayout } from "../../kernel/src/index.ts";

const streamSchema = "runtime-dispatch-stream/v1" as const;
const forbiddenKey = /(?:token|credential|password|secret|authorization|executablepath|api[-_ ]?key|private[-_ ]?key|cookie)/iu;
const bearer = /\bBearer\s+[^\s,;]+/giu;
const knownToken = /\b(?:sk|rk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{8,}\b/giu;
const sensitiveAssignment = /\b(?:authorization|cookie|credential(?:Ref)?|executablePath|api[-_ ]?key|accessToken|apiToken|password|private[-_ ]?key|secret|token)\s*[:=]\s*[^\s,;}]+/giu;

export interface DispatchStreamHeader {
  readonly schema: typeof streamSchema;
  readonly kind: "dispatch";
  readonly dispatchId: string;
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly runtimeSessionId: string;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly eventStreamRef: string;
  readonly agentId?: string;
  readonly agentName?: string;
  readonly delegatedByAgentId?: string;
  readonly delegatedByAgentName?: string;
  readonly squadId?: string;
  readonly onExitCommand?: string;
}

export interface DispatchStreamWriter {
  readonly ref: string;
  readonly appendProviderEvent: (value: unknown, occurredAt: string) => void;
  readonly appendProviderBinding: (providerSessionId: string, occurredAt: string) => void;
  readonly appendExitNotification: (value: { readonly phase: "started" | "finished"; readonly started: boolean; readonly exitCode: number | null; readonly timedOut: boolean; readonly errorCode?: string }, occurredAt: string) => void;
}

export function openDispatchStream(rootDir: string, header: Omit<DispatchStreamHeader, "schema" | "kind" | "eventStreamRef">): DispatchStreamWriter {
  const ref = dispatchStreamRef(rootDir, header.dispatchId), target = dispatchStreamPath(rootDir, header.dispatchId);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (!existsSync(target)) writeFileSync(target, `${JSON.stringify({ schema: streamSchema, kind: "dispatch", ...header, eventStreamRef: ref })}\n`, { encoding: "utf8", mode: 0o600 });
  return { ref, appendProviderEvent: (value, occurredAt) => appendJsonl(target, { schema: streamSchema, kind: "provider_event", occurredAt, event: scrubProviderValue(value) }), appendProviderBinding: (providerSessionId, occurredAt) => appendJsonl(target, { schema: streamSchema, kind: "provider_binding", occurredAt, providerSessionId }), appendExitNotification: (value, occurredAt) => appendJsonl(target, { schema: streamSchema, kind: "exit_notification", occurredAt, ...value }) };
}

export function readDispatchStream(rootDir: string, dispatchId: string): { readonly header: DispatchStreamHeader; readonly providerSessionId: string | null } | null {
  const target = dispatchStreamPath(rootDir, dispatchId);
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  const lines = readFileSync(target, "utf8").split(/\r?\n/u).filter(Boolean), first = parseRecord(lines[0]);
  if (!isHeader(first) || first.dispatchId !== dispatchId) return null;
  let providerSessionId: string | null = null;
  for (const line of lines.slice(1)) { const record = parseRecord(line); if (record?.kind === "provider_binding" && typeof record.providerSessionId === "string") providerSessionId = record.providerSessionId; }
  return { header: first, providerSessionId };
}

export function dispatchStreamRef(rootDir: string, dispatchId: string): string { const relative = path.relative(resolveHarnessLayout(rootDir).rootDir, dispatchStreamPath(rootDir, dispatchId)).split(path.sep).join("/"); return `file:${relative}`; }

export function scrubProviderValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubProviderValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !forbiddenKey.test(key)).map(([key, entry]) => [key, scrubProviderValue(entry)]));
  if (typeof value !== "string") return value;
  return value.replace(bearer, "Bearer [REDACTED]").replace(knownToken, "[REDACTED]").replace(sensitiveAssignment, "[REDACTED]");
}

function dispatchStreamPath(rootDir: string, dispatchId: string): string { if (!/^dispatch_[a-f0-9]{24}$/u.test(dispatchId)) throw new Error("dispatch id is invalid"); return path.join(resolveHarnessLayout(rootDir).localRoot, "runtime", "dispatches", `${dispatchId}.jsonl`); }
function appendJsonl(target: string, value: unknown): void { appendFileSync(target, `${JSON.stringify(scrubProviderValue(value))}\n`, { encoding: "utf8" }); }
function parseRecord(value: string | undefined): Record<string, unknown> | null { if (!value) return null; try { const parsed: unknown = JSON.parse(value); return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch (error) { consumeKnownError(error); return null; } }
function isHeader(value: Record<string, unknown> | null): value is Record<string, unknown> & DispatchStreamHeader { return value?.schema === streamSchema && value.kind === "dispatch" && typeof value.dispatchId === "string" && (value.taskId === null || typeof value.taskId === "string") && (value.executionId === null || typeof value.executionId === "string") && typeof value.runtimeSessionId === "string" && typeof value.instanceId === "string" && typeof value.startedAt === "string" && typeof value.eventStreamRef === "string"; }
