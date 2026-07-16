import type { EngineError } from "../../../kernel/src/index.ts";

export interface GithubRawIssue {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly stateReason: string | null;
  readonly htmlUrl: string;
  readonly assignee: string | null;
  readonly labels: ReadonlyArray<string>;
}

export type GithubIssueDecodeResult =
  | { readonly kind: "issue"; readonly issue: GithubRawIssue }
  | { readonly kind: "pull-request" }
  | { readonly kind: "error"; readonly error: EngineError };

export function decodeGithubIssue(value: unknown): GithubIssueDecodeResult {
  if (!isGithubPayloadRecord(value)) return malformed("github_issue_invalid:root");
  if (Object.hasOwn(value, "pull_request")) return { kind: "pull-request" };

  const number = value.number;
  if (!Number.isSafeInteger(number) || typeof number !== "number" || number <= 0) {
    return malformed("github_issue_invalid:number");
  }
  const title = value.title;
  if (typeof title !== "string") return malformed("github_issue_invalid:title");
  const state = value.state;
  if (typeof state !== "string" || state.length === 0) return malformed("github_issue_invalid:state");
  const stateReason = value.state_reason;
  if (stateReason !== null && typeof stateReason !== "string") {
    return malformed("github_issue_invalid:state_reason");
  }
  const htmlUrl = value.html_url;
  if (typeof htmlUrl !== "string" || !isGithubIssueUrl(htmlUrl)) {
    return malformed("github_issue_invalid:html_url");
  }
  const assignee = decodeAssignee(value.assignee);
  if (assignee.kind === "error") return assignee;
  const labels = decodeLabels(value.labels);
  if (labels.kind === "error") return labels;

  return {
    kind: "issue",
    issue: {
      number,
      title,
      state,
      stateReason,
      htmlUrl,
      assignee: assignee.value,
      labels: labels.value
    }
  };
}

export function decodeGithubIssueList(value: unknown):
  | { readonly kind: "issues"; readonly issues: ReadonlyArray<GithubRawIssue> }
  | { readonly kind: "error"; readonly error: EngineError } {
  if (!Array.isArray(value)) return malformedList("github_issue_list_invalid:root");
  const issues: GithubRawIssue[] = [];
  for (const item of value) {
    const decoded = decodeGithubIssue(item);
    if (decoded.kind === "pull-request") continue;
    if (decoded.kind === "error") return decoded;
    issues.push(decoded.issue);
  }
  return { kind: "issues", issues };
}

function decodeAssignee(value: unknown):
  | { readonly kind: "assignee"; readonly value: string | null }
  | { readonly kind: "error"; readonly error: EngineError } {
  if (value === null) return { kind: "assignee", value: null };
  if (!isGithubPayloadRecord(value) || typeof value.login !== "string" || value.login.length === 0) {
    return malformed("github_issue_invalid:assignee");
  }
  return { kind: "assignee", value: value.login };
}

function decodeLabels(value: unknown):
  | { readonly kind: "labels"; readonly value: ReadonlyArray<string> }
  | { readonly kind: "error"; readonly error: EngineError } {
  if (!Array.isArray(value)) return malformed("github_issue_invalid:labels");
  const labels: string[] = [];
  for (const label of value) {
    if (typeof label === "string") {
      labels.push(label);
      continue;
    }
    if (!isGithubPayloadRecord(label) || typeof label.name !== "string") {
      return malformed("github_issue_invalid:label_name");
    }
    labels.push(label.name);
  }
  return { kind: "labels", value: labels };
}

function malformed(raw: string): Extract<GithubIssueDecodeResult, { readonly kind: "error" }> {
  return { kind: "error", error: { _tag: "MalformedSnapshot", raw } };
}

function malformedList(raw: string): { readonly kind: "error"; readonly error: EngineError } {
  return { kind: "error", error: { _tag: "MalformedSnapshot", raw } };
}

function isGithubIssueUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && /\/issues\/[1-9][0-9]*\/?$/u.test(url.pathname);
  } catch {
    return false;
  }
}

function isGithubPayloadRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
