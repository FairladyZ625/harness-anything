import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const coldstartConclusionNames = Object.freeze([
  "passed",
  "product_failure",
  "infrastructure_invalid",
  "known_issue",
  "known_issue_drift",
  "fixed_candidate"
]);

export function loadColdstartKnownIssues(directory = new URL("./coldstart-known-issues/", import.meta.url), now = new Date()) {
  const directoryPath = directory instanceof URL ? fileURLToPath(directory) : directory;
  if (!existsSync(directoryPath)) return { issues: new Map(), invalid: [] };
  const issues = new Map();
  const invalid = [];
  for (const name of readdirSync(directoryPath).filter((entry) => entry.endsWith(".json")).sort()) {
    const operationId = name.slice(0, -5);
    const file = path.join(directoryPath, name);
    let marker;
    try {
      marker = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      invalid.push({ operationId, file, errors: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`] });
      continue;
    }
    const errors = validateColdstartKnownIssue(marker, operationId, now);
    if (errors.length > 0) {
      invalid.push({ operationId, file, errors });
      continue;
    }
    issues.set(operationId, { ...marker, file });
  }
  return { issues, invalid };
}

export function validateColdstartKnownIssue(marker, operationId, now = new Date()) {
  const errors = [];
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return ["marker must be a JSON object"];
  if (marker.schema !== "coldstart-known-issue/v1") errors.push("schema must be coldstart-known-issue/v1");
  if (!isIssueReference(marker.issue)) errors.push("issue must be a machine-checkable task id, #issue, or issue URL");
  if (typeof marker.owner !== "string" || !/^(?:agent|human|team):[a-z0-9][a-z0-9_.-]*$/iu.test(marker.owner)) {
    errors.push("owner must be an agent:, human:, or team: reference");
  }
  if (typeof marker.expiry !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(marker.expiry)) {
    errors.push("expiry must be YYYY-MM-DD");
  } else {
    const expiry = Date.parse(`${marker.expiry}T23:59:59.999Z`);
    if (!Number.isFinite(expiry) || expiry < now.getTime()) errors.push(`expiry ${marker.expiry} has passed`);
  }
  const action = marker.fingerprint?.action;
  if (action?.operationId !== operationId) errors.push(`fingerprint.action.operationId must equal sidecar id ${operationId}`);
  if (typeof action?.description !== "string" || action.description.trim().length === 0) {
    errors.push("fingerprint.action.description is required");
  }
  if (!Array.isArray(action?.argvPrefix) || action.argvPrefix.length === 0 || action.argvPrefix.some((value) => typeof value !== "string" || value.length === 0)) {
    errors.push("fingerprint.action.argvPrefix must be a non-empty string array");
  }
  const failure = marker.fingerprint?.failure;
  if (typeof failure?.errorCode !== "string" || failure.errorCode.length === 0) {
    errors.push("fingerprint.failure.errorCode is required");
  }
  if (typeof failure?.errorHintIncludes !== "string" || failure.errorHintIncludes.length === 0) {
    errors.push("fingerprint.failure.errorHintIncludes is required");
  }
  return errors;
}

export function classifyColdstartOperation(result, marker, invalidMarker) {
  if (invalidMarker) {
    return {
      conclusion: "infrastructure_invalid",
      knownIssue: null,
      detail: invalidMarker.errors.join("; ")
    };
  }
  const passed = result.exitCode === 0 && result.receiptOk === true;
  if (passed && marker) {
    return {
      conclusion: "fixed_candidate",
      knownIssue: marker.issue,
      detail: "The operation passed while its known-issue sidecar still exists; remove the stale marker."
    };
  }
  if (passed) return { conclusion: "passed", knownIssue: null, detail: null };
  if (!marker) {
    return {
      conclusion: "product_failure",
      knownIssue: null,
      detail: "The operation failed without a matching known-issue sidecar."
    };
  }

  const actionMatches = result.id === marker.fingerprint.action.operationId
    && marker.fingerprint.action.argvPrefix.every((token, index) => result.argv?.[index] === token);
  const failureMatches = result.errorCode === marker.fingerprint.failure.errorCode
    && String(result.errorHint ?? "").includes(marker.fingerprint.failure.errorHintIncludes);
  if (actionMatches && failureMatches) {
    return {
      conclusion: "known_issue",
      knownIssue: marker.issue,
      detail: marker.symptom ?? "Failure matches the declared action and failure fingerprint."
    };
  }
  return {
    conclusion: "known_issue_drift",
    knownIssue: marker.issue,
    detail: `Known-issue fingerprint drifted (action=${String(actionMatches)}, failure=${String(failureMatches)}).`
  };
}

export function buildColdstartConclusionMatrix({ results, setupResults = [], advertisedFailures = [], invalidMarkers = [], fatalError = null }) {
  const matrix = Object.fromEntries(coldstartConclusionNames.map((name) => [name, { count: 0, ids: [] }]));
  for (const result of results) {
    if (!(result.conclusion in matrix)) continue;
    matrix[result.conclusion].count += 1;
    matrix[result.conclusion].ids.push(result.id);
  }
  const infrastructure = [
    ...setupResults.filter((result) => result.exitCode !== 0 || result.receiptOk !== true).map((result) => `setup:${result.label}`),
    ...advertisedFailures.map((result) => `capabilities:${result.kind}`),
    ...invalidMarkers.map((result) => `known-issue:${result.operationId}`),
    ...(fatalError ? ["runner:fatal"] : [])
  ];
  for (const id of infrastructure) {
    if (matrix.infrastructure_invalid.ids.includes(id)) continue;
    matrix.infrastructure_invalid.count += 1;
    matrix.infrastructure_invalid.ids.push(id);
  }
  return matrix;
}

export function coldstartReportFails(report) {
  const failing = ["product_failure", "infrastructure_invalid", "known_issue_drift", "fixed_candidate"];
  return failing.some((name) => (report.conclusions?.[name]?.count ?? 0) > 0)
    || (report.cleanup?.errors?.length ?? 0) > 0;
}

function isIssueReference(value) {
  return typeof value === "string" && (/^task_[0-9A-Z]+$/u.test(value) || /^#\d+$/u.test(value) || /^https:\/\/[^\s]+\/issues\/\d+$/u.test(value));
}
