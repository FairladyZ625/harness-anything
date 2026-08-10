import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const integrationTestTimingSchema = "harness-integration-test-timings/v1";

export function integrationTestFilesFingerprint(files) {
  const normalized = [...new Set(files)].sort();
  if (normalized.length !== files.length) {
    throw new Error("integration manifest contains duplicate files");
  }
  return sha256(`${JSON.stringify(normalized)}\n`);
}

export function packageLockFingerprint(repoRoot) {
  return sha256(readFileSync(path.join(repoRoot, "package-lock.json")));
}

export function createIntegrationTestTimingReport({
  manifestFiles,
  workers,
  shardId,
  shardCount,
  source,
  nodeVersion,
  packageLockSha256
}) {
  assertPositiveInteger(shardId, "timing shard id");
  assertPositiveInteger(shardCount, "timing shard count");
  if (shardId > shardCount) throw new Error("timing shard id exceeds shard count");
  validateSource(source);
  if (typeof nodeVersion !== "string" || nodeVersion.length === 0) {
    throw new Error("timing report requires a Node version");
  }
  if (!/^[a-f0-9]{64}$/u.test(packageLockSha256)) {
    throw new Error("timing report requires a package-lock SHA-256");
  }

  const manifestSet = new Set(manifestFiles);
  const seen = new Set();
  const files = workers.map((worker) => {
    if (worker.outcome !== "passed" && worker.outcome !== "passed-after-reap") {
      throw new Error("timing artifacts may contain only successful workers");
    }
    if (!manifestSet.has(worker.file)) {
      throw new Error(`timing worker is outside the integration manifest: ${worker.file}`);
    }
    if (seen.has(worker.file)) throw new Error(`duplicate timing file: ${worker.file}`);
    if (!Number.isFinite(worker.durationMs) || worker.durationMs <= 0) {
      throw new Error(`timing worker has an invalid duration: ${worker.file}`);
    }
    seen.add(worker.file);
    return {
      path: worker.file,
      durationMs: Math.round(worker.durationMs * 1000) / 1000
    };
  }).sort((left, right) => left.path.localeCompare(right.path));

  if (files.length === 0) throw new Error("timing shard contains no files");
  return {
    schema: integrationTestTimingSchema,
    purpose: "scheduling-only",
    source: { ...source },
    runtime: {
      nodeVersion,
      packageLockSha256,
      testFilesSha256: integrationTestFilesFingerprint(manifestFiles)
    },
    shard: { id: shardId, count: shardCount },
    files
  };
}

export function validateIntegrationTestTimingReport(report) {
  const errors = [];
  if (report?.schema !== integrationTestTimingSchema) errors.push("timing report schema is invalid");
  if (report?.purpose !== "scheduling-only") errors.push("timing report purpose is invalid");
  try {
    validateSource(report?.source);
  } catch (error) {
    errors.push(error.message);
  }
  if (typeof report?.runtime?.nodeVersion !== "string" || report.runtime.nodeVersion.length === 0) {
    errors.push("timing report requires a Node version");
  }
  for (const [label, value] of [
    ["package-lock", report?.runtime?.packageLockSha256],
    ["test-files", report?.runtime?.testFilesSha256]
  ]) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
      errors.push(`timing report requires a ${label} SHA-256`);
    }
  }
  if (!Number.isInteger(report?.shard?.id) || report.shard.id < 1) errors.push("timing shard id is invalid");
  if (!Number.isInteger(report?.shard?.count) || report.shard.count < 1) errors.push("timing shard count is invalid");
  if (report?.shard?.id > report?.shard?.count) errors.push("timing shard id exceeds shard count");
  if (!Array.isArray(report?.files) || report.files.length === 0) {
    errors.push("timing report files are missing");
  } else {
    const seen = new Set();
    for (const file of report.files) {
      if (typeof file?.path !== "string" || file.path.length === 0) errors.push("timing file path is invalid");
      if (!Number.isFinite(file?.durationMs) || file.durationMs <= 0) errors.push(`timing duration is invalid: ${file?.path ?? "unknown"}`);
      if (seen.has(file?.path)) errors.push(`duplicate timing file: ${file.path}`);
      seen.add(file?.path);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function writeIntegrationTestTimingReport(outputPath, report) {
  const validation = validateIntegrationTestTimingReport(report);
  if (!validation.ok) throw new Error(validation.errors.join("\n"));
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function validateSource(source) {
  if (typeof source?.repository !== "string" || source.repository.length === 0) {
    throw new Error("timing report requires a source repository");
  }
  if (typeof source?.commitSha !== "string" || !/^[a-f0-9]{40}$/u.test(source.commitSha)) {
    throw new Error("timing report requires a 40-character source commit SHA");
  }
  if (typeof source?.runId !== "string" || source.runId.length === 0) {
    throw new Error("timing report requires a source run id");
  }
  assertPositiveInteger(source?.runAttempt, "timing source run attempt");
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
