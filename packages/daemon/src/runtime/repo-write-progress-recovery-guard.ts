import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync
} from "node:fs";
import path from "node:path";
import {
  resolveHarnessLayout,
  sha256Text,
  stablePayloadHash,
  taskEntityId,
  taskPackagePath,
  type HarnessLayoutInput,
  type TaskId
} from "@harness-anything/kernel";

export type RepoWriteProgressRecoveryGuardResult =
  "not-pending" | "not-materialized" | "already-marked" | "marker-repaired";

/**
 * Repairs only the cutover-exposed crash window where a progress delta reached
 * its worktree file but the kernel process died before appending apply-marker.
 * Git HEAD supplies the exact pre-effect bytes, so identical prior entries are
 * not mistaken for this operation's materialized effect.
 */
export function guardProgressAppendRecoveryEffect(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly opId: string;
  readonly now?: () => Date;
}): RepoWriteProgressRecoveryGuardResult {
  const layout = resolveHarnessLayout(input.rootInput);
  if (!existsSync(layout.journalPath)) return "not-pending";
  const lines = readFileSync(layout.journalPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parseJournalLine);
  if (lines.some((line) =>
    line.schema === "apply-marker/v1" && line.opId === input.opId)) {
    return "already-marked";
  }
  const matching = lines.filter((line) =>
    (line.schema === "write-journal/v1"
      || line.schema === "write-journal/v2")
    && line.opId === input.opId);
  if (matching.length === 0) return "not-pending";
  if (matching.length !== 1) {
    throw new Error(`REPO_WRITE_PROGRESS_RECOVERY_RECORD_AMBIGUOUS:${input.opId}`);
  }
  const record = matching[0]!;
  if (record.kind !== "progress_append"
    || typeof record.entityId !== "string"
    || !record.entityId.startsWith("task/")) {
    throw new Error(`REPO_WRITE_PROGRESS_RECOVERY_RECORD_MISMATCH:${input.opId}`);
  }
  const taskId = record.entityId.slice("task/".length) as TaskId;
  if (taskEntityId(taskId) !== record.entityId) {
    throw new Error(`REPO_WRITE_PROGRESS_RECOVERY_ENTITY_INVALID:${input.opId}`);
  }
  const payload = readVerifiedPayload(
    recoveryCanonicalRoot(input.rootInput),
    record,
    input.opId
  );
  if (payload.path !== "progress.md"
    || typeof payload.append !== "string"
    || "body" in payload) {
    throw new Error(`REPO_WRITE_PROGRESS_RECOVERY_PAYLOAD_MISMATCH:${input.opId}`);
  }

  const target = path.join(
    taskPackagePath(input.rootInput, taskId),
    "progress.md"
  );
  const baseline = gitHeadFile(target);
  const current = existsSync(target)
    ? readFileSync(target, "utf8")
    : "# Progress\n\n## Entries\n\n";
  if (current === baseline) return "not-materialized";
  const separator = baseline.length > 0 && !baseline.endsWith("\n") ? "\n" : "";
  const expected = `${baseline}${separator}${payload.append}\n`;
  if (current !== expected) {
    throw new Error(`REPO_WRITE_PROGRESS_RECOVERY_EFFECT_AMBIGUOUS:${input.opId}`);
  }

  appendMarker(layout.journalPath, {
    schema: "apply-marker/v1",
    opId: input.opId,
    entityId: record.entityId,
    at: (input.now ?? (() => new Date()))().toISOString()
  });
  return "marker-repaired";
}

function readVerifiedPayload(
  rootDir: string,
  record: Record<string, unknown>,
  opId: string
): Record<string, unknown> {
  const payloadRef = asRecord(record.payloadRef, opId);
  if (typeof payloadRef.path !== "string"
    || typeof payloadRef.sha256 !== "string") {
    throw new Error(`REPO_WRITE_PROGRESS_RECOVERY_PAYLOAD_REF_INVALID:${opId}`);
  }
  const absolute = path.resolve(rootDir, payloadRef.path);
  if (absolute !== rootDir && !absolute.startsWith(`${rootDir}${path.sep}`)) {
    throw new Error(`REPO_WRITE_PROGRESS_RECOVERY_PAYLOAD_REF_ESCAPE:${opId}`);
  }
  const text = readFileSync(absolute, "utf8");
  if (sha256Text(text) !== payloadRef.sha256) {
    throw new Error(`REPO_WRITE_PROGRESS_RECOVERY_PAYLOAD_REF_HASH:${opId}`);
  }
  const payload = asRecord(JSON.parse(text), opId);
  const envelope = asRecord(record.payload, opId);
  if (typeof envelope.payloadHash !== "string"
    || stablePayloadHash(payload) !== envelope.payloadHash) {
    throw new Error(`REPO_WRITE_PROGRESS_RECOVERY_PAYLOAD_HASH:${opId}`);
  }
  return payload;
}

function gitHeadFile(target: string): string {
  const cwd = path.dirname(target);
  const root = execFileSync(
    "git",
    ["rev-parse", "--show-toplevel"],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  ).trim();
  const head = execFileSync(
    "git",
    ["rev-parse", "HEAD"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  ).trim();
  const relative = path.relative(root, realpathSync(target))
    .split(path.sep).join("/");
  const exists = spawnSync(
    "git",
    ["cat-file", "-e", `${head}:${relative}`],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    }
  );
  if (exists.status === 1) return "# Progress\n\n## Entries\n\n";
  if (exists.status !== 0) {
    throw new Error(
      `REPO_WRITE_PROGRESS_RECOVERY_GIT_BASELINE_UNAVAILABLE:${
        String(exists.stderr ?? "").trim()
      }`
    );
  }
  return execFileSync(
    "git",
    ["show", `${head}:${relative}`],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );
}

function appendMarker(
  journalPath: string,
  marker: Record<string, unknown>
): void {
  const fd = openSync(journalPath, "a");
  try {
    writeSync(fd, `${JSON.stringify(marker)}\n`, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function parseJournalLine(line: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(line), "journal");
  } catch (error) {
    throw new Error("REPO_WRITE_PROGRESS_RECOVERY_JOURNAL_INVALID", {
      cause: error
    });
  }
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`REPO_WRITE_PROGRESS_RECOVERY_RECORD_INVALID:${context}`);
  }
  return value as Record<string, unknown>;
}

function recoveryCanonicalRoot(input: HarnessLayoutInput): string {
  return path.resolve(typeof input === "string" ? input : input.rootDir);
}
