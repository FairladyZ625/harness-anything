import { globSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { runtimeSessionOutcomeFromEvidence } from "@harness-anything/kernel";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readDispatchStream } from "./dispatch-stream.ts";
import { runtimePidIsAlive } from "./runtime-process-liveness.ts";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";
import { writeFileDurably } from "./durable-file.ts";

const git = promisify(execFile);
const supportedVersions = new Set(["0.159.1", "0.159.3"]);
const portableTools = new Set([
  "exec",
  "exec_command",
  "shell",
  "shell_command",
  "write_stdin",
  "apply_patch",
  "view_image",
  "update_plan",
]);

/** Only the explicitly selected, task-bound rollout is read. No credentials or indexes travel. */
export async function prepareRuntimeHandoff(rootDir: string, userRoot: string, dispatchId: string) {
  const stream = readDispatchStream(rootDir, dispatchId);
  if (
    !stream ||
    !stream.header.handoffEnabled ||
    stream.header.kindId !== "codex" ||
    !stream.header.taskId ||
    !stream.header.executionId ||
    !stream.header.cwd ||
    !stream.providerSessionId ||
    stream.header.schedule ||
    stream.header.role === "reviewer"
  )
    throw runtimeSpawnError("runtime_handoff_ineligible", "Export requires a new opted-in task-bound Codex dispatch.");
  if (
    !stream.process?.exited ||
    runtimePidIsAlive(stream.process.pid) ||
    !stream.terminalOutcome ||
    runtimeSessionOutcomeFromEvidence(stream.terminalOutcome.payload) === "unknown"
  )
    throw runtimeSpawnError(
      "runtime_handoff_source_active",
      "The source process and its stream must be settled on this node.",
    );
  const cwd = stream.header.cwd;
  const runGit = async (args: string[]) =>
    (
      await git("git", args, {
        cwd,
        timeout: 30_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      })
    ).stdout.trim();
  if (await runGit(["status", "--porcelain"]))
    throw runtimeSpawnError("runtime_handoff_dirty", "Commit or discard workspace changes before exporting.");
  const commit = await runGit(["rev-parse", "HEAD"]);
  const published = await runGit(["ls-remote", "--exit-code", "origin", `refs/heads/${stream.header.taskId}`]);
  if (published.split(/\s/u)[0] !== commit)
    throw runtimeSpawnError(
      "runtime_handoff_commit_unpublished",
      "The task branch must publish the exact workspace commit first.",
    );
  const sessions = codexSessions(userRoot, stream.header.instanceId),
    matches = globSync(`**/rollout-*-${safeId(stream.providerSessionId)}.jsonl`, { cwd: sessions });
  if (matches.length !== 1)
    throw runtimeSpawnError(
      "runtime_handoff_rollout_missing",
      "The selected session must have exactly one native rollout.",
    );
  const body = readFileSync(path.join(sessions, matches[0]!));
  const version = validateHandoffRollout(body, stream.providerSessionId);
  return { dispatchId, commit, providerSessionId: stream.providerSessionId, version, body };
}

export function validateHandoffRollout(body: Uint8Array, providerSessionId: string): string {
  let version: string | undefined;
  const records = new TextDecoder("utf-8", { fatal: true }).decode(body).trimEnd().split("\n");
  for (const [index, line] of records.entries()) {
    const record = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
    if (
      ![
        "session_meta",
        "response_item",
        "event_msg",
        "turn_context",
        "compacted",
        "world_state",
        "token_usage_record",
      ].includes(record.type ?? "")
    )
      throw runtimeSpawnError("runtime_handoff_closure_unsupported", "The rollout contains an unverified record type.");
    if (index === 0) {
      if (
        record.type !== "session_meta" ||
        record.payload?.id !== providerSessionId ||
        !supportedVersions.has(String(record.payload.cli_version))
      )
        throw runtimeSpawnError(
          "runtime_handoff_version_unsupported",
          "Only verified Codex 0.159.1 and 0.159.3 native rollouts are supported.",
        );
      version = String(record.payload.cli_version);
    }
    if (index === 0 && !Number.isFinite(new Date(String(record.payload?.timestamp)).getTime()))
      throw runtimeSpawnError("runtime_handoff_rollout_invalid", "Session timestamp is invalid.");
    inspectClosure(record);
  }
  if (!version) throw runtimeSpawnError("runtime_handoff_rollout_missing", "The native rollout is empty.");
  return version;
}

function inspectClosure(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) inspectClosure(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (
    (typeof row.image_url === "string" && !row.image_url.startsWith("data:image/")) ||
    row.file_id !== undefined ||
    row.type === "input_file" ||
    ((row.type === "function_call" || row.type === "custom_tool_call") &&
      (typeof row.name !== "string" || !portableTools.has(row.name)))
  )
    throw runtimeSpawnError(
      "runtime_handoff_closure_unsupported",
      "External image/file resources and unverified tools are not portable in this release.",
    );
  for (const child of Object.values(row)) inspectClosure(child);
}

export function installHandoffRollout(userRoot: string, instanceId: string, sessionId: string, body: Uint8Array): void {
  validateHandoffRollout(body, sessionId);
  const sessions = codexSessions(userRoot, instanceId);
  const existing = existsSync(sessions) ? globSync(`**/rollout-*-${safeId(sessionId)}.jsonl`, { cwd: sessions }) : [];
  if (existing.length === 1 && readFileSync(path.join(sessions, existing[0]!)).equals(Buffer.from(body))) return;
  if (existing.length)
    throw runtimeSpawnError(
      "runtime_handoff_target_exists",
      "The target already contains a different native session state; inspect its prior dispatch.",
    );
  const first = JSON.parse(Buffer.from(body).toString("utf8").split("\n")[0]!) as { payload: { timestamp: string } };
  const date = new Date(first.payload.timestamp);
  if (!Number.isFinite(date.getTime()))
    throw runtimeSpawnError("runtime_handoff_rollout_invalid", "Session timestamp is invalid.");
  const iso = date.toISOString();
  writeFileDurably(
    path.join(
      sessions,
      iso.slice(0, 4),
      iso.slice(5, 7),
      iso.slice(8, 10),
      `rollout-${iso.slice(0, 19).replaceAll(":", "-")}-${safeId(sessionId)}.jsonl`,
    ),
    body,
    0o600,
  );
}

function codexSessions(userRoot: string, instanceId: string): string {
  return path.join(userRoot, "runtime-instances", safeId(instanceId), "home", ".codex", "sessions");
}
function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value))
    throw runtimeSpawnError("invalid_field", "Invalid native session or instance identity.");
  return value;
}
