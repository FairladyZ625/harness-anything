import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findPrivateLeakage } from "../../evals/closeout-reviewer/run-eval.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PRIVATE_BOUNDARY_ALLOWLIST_PATH = path.join(REPO_ROOT, "tools", "gate-allowlists", "check-private-boundary.json");

const LEDGER_PRIVATE_PATH_PATTERN =
  /(?:^|[^a-zA-Z0-9_.-])(?:\.harness-private\/|\.harness\/|harness\/|\.retro-local\/|\.worktrees\/)/gu;
const RAW_INTERNAL_ID_PATTERN =
  /\b(?:task_[0-9a-f]{26}|exe_[0-9a-f]{26}|dispatch_[0-9a-f]{24}|runtime_[0-9a-f]{24}|review-dispatch_[0-9a-f]{24}|consent-[0-9a-f]{24}|person_[a-z0-9_-]+)\b/giu;
const UNIX_USER_PATH_PATTERN = /(?:\/Users\/|\/home\/|\/root\/)[^\s"'`,;)}\]]+/gu;
const WINDOWS_ABS_PATH_PATTERN =
  /\b[A-Za-z]:(?:\\|\/)(?:Users|harness-edge|project|Projects|Documents|Desktop|AppData|Program Files|Windows|Temp|tmp|home|var|opt|srv|etc|[A-Za-z0-9._-]+(?:\\|\/)[^\s"'`,;)}\]]*)[^\s"'`,;)}\]]*/gu;
const UNC_PATH_PATTERN = /(?:^|[\s"'`(])(\\\\[A-Za-z0-9][A-Za-z0-9._-]+\\[A-Za-z0-9._$-][^\s"'`,;)}\]]*)/gu;
const LEDGER_REL_PACKAGE_PATTERN =
  /\b(?:tasks\/task_[0-9a-f]{26}[^\s"'`,;)}\]]*|decisions\/decision-dec_[0-9A-Za-z_-]+[^\s"'`,;)}\]]*)/gu;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu;
const SECRET_TOKEN_PATTERN =
  /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})\b|-----BEGIN [A-Z ]+PRIVATE KEY-----/gu;

let cachedBoundaryMarkers = null;

/** Load private content markers dynamically from check-private-boundary.json so SSoT stays single. */
export function loadPrivateBoundaryMarkers(allowlistPath = PRIVATE_BOUNDARY_ALLOWLIST_PATH) {
  if (allowlistPath === PRIVATE_BOUNDARY_ALLOWLIST_PATH && cachedBoundaryMarkers !== null) {
    return cachedBoundaryMarkers;
  }
  if (!existsSync(allowlistPath)) return [];
  const parsed = JSON.parse(readFileSync(allowlistPath, "utf8"));
  const entries = parsed?.entries?.privateContentMarkers ?? [];
  const markers = entries
    .map((entry) => (Array.isArray(entry.parts) ? entry.parts.join("") : ""))
    .filter((value) => value.length > 0);
  if (allowlistPath === PRIVATE_BOUNDARY_ALLOWLIST_PATH) {
    cachedBoundaryMarkers = markers;
  }
  return markers;
}

export class SanitizeError extends Error {
  constructor(message, hits = []) {
    super(message);
    this.name = "SanitizeError";
    this.code = "private_leakage_detected";
    this.hits = hits;
  }
}

function collectStringValues(node, out = []) {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStringValues(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      out.push(key);
      collectStringValues(value, out);
    }
  }
  return out;
}

/**
 * Scan any string or JSON-serializable document for private ledger paths, raw internal IDs,
 * local machine paths (POSIX & Windows), secrets, or check-private-boundary markers.
 */
export function findRetroPrivateLeakage(document, options = {}) {
  const strings = collectStringValues(document);
  const hits = [];
  const seen = new Set();

  const record = (rule, rawMatch) => {
    const match = String(rawMatch).trim();
    const key = `${rule}\0${match}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ rule, match });
  };

  const rulePatterns = [
    ["ledger-private-path", LEDGER_PRIVATE_PATH_PATTERN],
    ["raw-internal-id", RAW_INTERNAL_ID_PATTERN],
    ["unix-user-path", UNIX_USER_PATH_PATTERN],
    ["windows-abs-path", WINDOWS_ABS_PATH_PATTERN],
    ["unc-path", UNC_PATH_PATTERN],
    ["ledger-package-path", LEDGER_REL_PACKAGE_PATTERN],
    ["secret-token", SECRET_TOKEN_PATTERN],
  ];
  const markers = options.boundaryMarkers ?? loadPrivateBoundaryMarkers();

  for (const text of strings) {
    for (const baseHit of findPrivateLeakage(text)) {
      record("closeout-reviewer-private-leak", baseHit);
    }

    for (const [rule, pattern] of rulePatterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      for (const match of text.matchAll(regex)) {
        record(rule, match[1] ?? match[0]);
      }
    }

    for (const marker of markers) {
      if (text.includes(marker)) {
        record("private-boundary-marker", marker);
      }
    }
  }

  return {
    ok: hits.length === 0,
    hits,
  };
}

/**
 * Redact private ledger paths, local machine paths, internal IDs, emails, and secrets from prose text.
 */
export function sanitizeText(value, options = {}) {
  if (typeof value !== "string") return value;
  let result = value;

  const markers = options.boundaryMarkers ?? loadPrivateBoundaryMarkers();
  for (const marker of markers) {
    if (result.includes(marker)) {
      result = result.split(marker).join("<redacted-private-marker>");
    }
  }

  result = result
    .replace(SECRET_TOKEN_PATTERN, "<redacted-secret>")
    .replace(UNC_PATH_PATTERN, (full, captured) => full.replace(captured, "<redacted-unc-path>"))
    .replace(WINDOWS_ABS_PATH_PATTERN, "<redacted-local-path>")
    .replace(UNIX_USER_PATH_PATTERN, "<redacted-local-path>")
    .replace(LEDGER_REL_PACKAGE_PATTERN, "<redacted-ledger-package>")
    .replace(
      /(^|[^a-zA-Z0-9_.-])(?:\.harness-private\/|\.harness\/|harness\/|\.retro-local\/|\.worktrees\/)[^\s"'`,;)}\]]*/gu,
      "$1<redacted-private-path>",
    )
    .replace(RAW_INTERNAL_ID_PATTERN, (match) => {
      const lower = match.toLowerCase();
      if (lower.startsWith("task_")) return "<redacted-task-id>";
      if (lower.startsWith("exe_")) return "<redacted-execution-id>";
      if (lower.startsWith("dispatch_") || lower.startsWith("review-dispatch_")) return "<redacted-dispatch-id>";
      if (lower.startsWith("runtime_")) return "<redacted-runtime-id>";
      if (lower.startsWith("consent-")) return "<redacted-consent-id>";
      if (lower.startsWith("person_")) return "<redacted-person>";
      return "<redacted-id>";
    })
    .replace(EMAIL_PATTERN, "<redacted-email>");

  return result;
}

/** Recursively sanitize string fields inside a retro case (preserving diff structure unless requested). */
export function sanitizeRetroCase(rawCase, options = {}) {
  const sanitizeStrings = (node, keyName = "") => {
    if (typeof node === "string") {
      if (keyName === "diff" && options.sanitizeDiff !== true) {
        return node;
      }
      return sanitizeText(node, options);
    }
    if (Array.isArray(node)) {
      return node.map((item) => sanitizeStrings(item, keyName));
    }
    if (node && typeof node === "object") {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = sanitizeStrings(v, k);
      }
      return out;
    }
    return node;
  };

  const sanitized = sanitizeStrings(rawCase);
  const scan = findRetroPrivateLeakage(sanitized, options);
  if (!scan.ok) {
    const summary = scan.hits.map((hit) => `${hit.rule}:${hit.match}`).join(", ");
    throw new SanitizeError(
      `Private leakage remained after sanitization for case ${sanitized?.id ?? "<unknown>"}: ${summary}`,
      scan.hits,
    );
  }
  return sanitized;
}

/** Assert zero private leakage across a complete dataset document; throws SanitizeError on any hit. */
export function assertNoPrivateLeakage(document, label = "dataset", options = {}) {
  const scan = findRetroPrivateLeakage(document, options);
  if (!scan.ok) {
    const summary = scan.hits.map((hit) => `${hit.rule}:${hit.match}`).join(", ");
    throw new SanitizeError(`Private leakage detected in ${label}: ${summary}`, scan.hits);
  }
  return scan;
}
