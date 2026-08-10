import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

const channelDefinitions = {
  driverInvocations: { path: "evidence/driver-invocations.jsonl", required: true, authority: "source-of-truth", format: "jsonl" },
  cliReceipts: { path: "evidence/cli-receipts.jsonl", required: true, authority: "corroborating", format: "jsonl" },
  durableState: { path: "evidence/durable-state.json", required: true, authority: "durable-state", format: "json" },
  subjectActions: { path: "evidence/subject-actions.json", required: true, authority: "raw", format: "json" },
  runtimeEvents: { path: "evidence/runtime-events.json", required: false, authority: "ancillary", format: "json" },
  fixtureSetup: { path: "evidence/fixture-setup.json", required: true, authority: "fixture", format: "json" }
};

export function prepareRunDirectory(runDir) {
  if (!path.isAbsolute(runDir)) throw new Error("--run-dir must be absolute");
  if (existsSync(runDir)) throw new Error(`append-only run directory already exists: ${runDir}`);
  mkdirSync(path.join(runDir, "evidence"), { recursive: true, mode: 0o700 });
}

export function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
}

export function writeJsonLines(filePath, rows) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  writeFileSync(filePath, body.length > 0 ? `${body}\n` : "", { encoding: "utf8", mode: 0o600, flag: "w" });
}

export function hashBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hashFile(filePath) {
  return hashBytes(readFileSync(filePath));
}

export function reconcileEvidence(runDir, expectedVerificationIds) {
  const evidence = { root: "evidence" };
  const contents = {};
  const issues = [];
  const checks = [];

  for (const [name, definition] of Object.entries(channelDefinitions)) {
    const inspected = inspectChannel(runDir, definition);
    evidence[name] = inspected.descriptor;
    contents[name] = inspected.value;
    const status = !definition.required || inspected.descriptor.status === "present" ? "passed" : "failed";
    checks.push({
      id: `${name}-channel`,
      status,
      detail: inspected.descriptor.status === "present"
        ? `${definition.path} contains ${inspected.descriptor.recordCount} record(s)`
        : `${definition.path} is ${inspected.descriptor.status}`
    });
    if (definition.required && status === "failed") issues.push(`missing-required-channel:${name}`);
  }

  const invocations = Array.isArray(contents.driverInvocations) ? contents.driverInvocations : [];
  const receipts = Array.isArray(contents.cliReceipts) ? contents.cliReceipts : [];
  const invocationIds = invocations.map((row) => row.invocationId);
  const receiptIds = receipts.map((row) => row.invocationId);
  const matched = invocationIds.filter((id) => receiptIds.includes(id)).length;
  const exactIds = invocationIds.length === receiptIds.length
    && new Set(invocationIds).size === invocationIds.length
    && new Set(receiptIds).size === receiptIds.length
    && matched === invocationIds.length;
  checks.push({
    id: "driver-receipt-correlation",
    status: exactIds ? "passed" : "failed",
    detail: `${matched}/${invocationIds.length} driver invocation id(s) have exactly one receipt capture`
  });
  if (!exactIds) issues.push("driver-receipt-correlation-mismatch");

  const expectedReceiptFailures = receipts.filter((row) => row.receiptExpected && row.parseStatus !== "parsed");
  checks.push({
    id: "expected-receipts-parsed",
    status: expectedReceiptFailures.length === 0 && receipts.length > 0 ? "passed" : "failed",
    detail: expectedReceiptFailures.length === 0 ? "every receipt-bearing invocation has a parsed CLI receipt" : `${expectedReceiptFailures.length} expected receipt(s) were not parsed`
  });
  if (expectedReceiptFailures.length > 0 || receipts.length === 0) issues.push("expected-cli-receipt-missing");

  const durableState = isObject(contents.durableState) ? contents.durableState : null;
  const durableChecks = Array.isArray(durableState?.checks) ? durableState.checks : [];
  const durableIds = new Set(durableChecks.map((check) => check.id));
  const verificationCovered = expectedVerificationIds.every((id) => durableIds.has(id));
  checks.push({
    id: "durable-verification-coverage",
    status: verificationCovered ? "passed" : "failed",
    detail: `${expectedVerificationIds.filter((id) => durableIds.has(id)).length}/${expectedVerificationIds.length} declared durable verification(s) have an outcome`
  });
  if (!verificationCovered) issues.push("durable-verification-coverage-missing");

  const createdTaskId = deepString(
    receipts.find((row) => row.opportunityId === "task-create" && row.parseStatus === "parsed")?.receipt,
    "taskId"
  );
  const durableTaskId = typeof durableState?.task?.taskId === "string" ? durableState.task.taskId : null;
  const taskIdsMatch = Boolean(createdTaskId && durableTaskId && createdTaskId === durableTaskId);
  checks.push({
    id: "receipt-durable-task-id",
    status: taskIdsMatch ? "passed" : "failed",
    detail: taskIdsMatch ? `receipt and durable state agree on ${createdTaskId}` : "task create receipt and durable state do not expose the same task id"
  });
  if (!taskIdsMatch) issues.push("receipt-durable-task-id-mismatch");

  const requiredPresent = Object.values(evidence)
    .filter((channel) => isObject(channel) && channel.required)
    .every((channel) => channel.status === "present");
  const status = requiredPresent && issues.length === 0 ? "complete" : "incomplete";
  const productOutcome = status === "complete"
    ? durableChecks.length > 0 && durableChecks.every((check) => check.status === "passed") ? "passed" : "failed"
    : "unknown";
  return {
    evidence,
    contents,
    reconciliation: {
      status,
      productOutcome,
      matchedInvocationReceipts: matched,
      expectedInvocationReceipts: invocationIds.length,
      checks,
      issues: [...new Set(issues)].sort(),
      runtimeEventsUsedForVerdict: false
    }
  };
}

export function sealRunDirectory(runDir) {
  walkBottomUp(runDir, (entryPath, stat) => chmodSync(entryPath, stat.isDirectory() ? 0o555 : 0o444));
}

export function makeRunDirectoryWritable(runDir) {
  walkTopDown(runDir, (entryPath, stat) => chmodSync(entryPath, stat.isDirectory() ? 0o700 : 0o600));
}

export const evidenceChannelPaths = Object.freeze(Object.fromEntries(
  Object.entries(channelDefinitions).map(([name, definition]) => [name, definition.path])
));

function inspectChannel(runDir, definition) {
  const absolutePath = path.join(runDir, definition.path);
  if (!existsSync(absolutePath)) {
    return {
      descriptor: {
        status: definition.required ? "missing" : "not-collected",
        required: definition.required,
        authority: definition.authority,
        path: definition.path,
        sha256: null,
        recordCount: 0
      },
      value: null
    };
  }
  const body = readFileSync(absolutePath, "utf8");
  let value;
  let recordCount;
  try {
    if (definition.format === "jsonl") {
      value = body.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
      recordCount = value.length;
    } else {
      value = JSON.parse(body);
      recordCount = typeof value?.totalRecords === "number" ? value.totalRecords : 1;
    }
  } catch {
    value = null;
    recordCount = 0;
  }
  return {
    descriptor: {
      status: value === null ? "missing" : "present",
      required: definition.required,
      authority: definition.authority,
      path: definition.path,
      sha256: value === null ? null : hashBytes(body),
      recordCount
    },
    value
  };
}

function deepString(root, key) {
  const queue = [root];
  const seen = new Set();
  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (typeof value[key] === "string") return value[key];
    for (const child of Object.values(value)) if (child && typeof child === "object") queue.push(child);
  }
  return null;
}

function walkTopDown(root, visit) {
  const stat = statSync(root);
  visit(root, stat);
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(root)) walkTopDown(path.join(root, entry), visit);
}

function walkBottomUp(root, visit) {
  const stat = statSync(root);
  if (stat.isDirectory()) for (const entry of readdirSync(root)) walkBottomUp(path.join(root, entry), visit);
  visit(root, stat);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
