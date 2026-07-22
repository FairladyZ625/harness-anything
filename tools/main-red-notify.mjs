const notificationMarker = "<!-- main-red-notification -->";

function cleanInline(value) {
  return String(value).replace(/[\r\n]+/gu, " ").trim();
}

export const mainRedLabel = "main-red";
export const mainRedIssueTitle = "[CI] rewrite-ci is red on main";

export function mainRedShaMarker(headSha) {
  return `<!-- main-red-sha:${cleanInline(headSha)} -->`;
}

export function mainRedRunMarker(runId) {
  return `<!-- main-red-run:${cleanInline(runId)} -->`;
}

export function readMainRedRunId(issue) {
  const match = typeof issue.body === "string" ? issue.body.match(/<!-- main-red-run:(\d+) -->/u) : null;
  return match === null ? null : Number(match[1]);
}

export function buildMainRedIssueBody({ runId, runUrl, headSha, failedJobs }) {
  const jobs = [...new Set(failedJobs.map(cleanInline).filter(Boolean))];
  const jobLines = jobs.length > 0 ? jobs.map((name) => `- ${name}`) : ["- Unable to identify a failed job from the run API."];
  return [
    notificationMarker,
    mainRedRunMarker(runId),
    mainRedShaMarker(headSha),
    "## rewrite-ci is red on main",
    "",
    `- Run: ${cleanInline(runUrl)}`,
    `- Head SHA: \`${cleanInline(headSha)}\``,
    "- Failed jobs:",
    ...jobLines,
    "",
    "This issue is advisory only. It does not change required checks, branch protection, or merge enforcement."
  ].join("\n");
}

export function buildMainRedRecoveryComment({ runUrl, headSha }) {
  return `rewrite-ci is green again on main for \`${cleanInline(headSha)}\`: ${cleanInline(runUrl)}. Closing this advisory issue.`;
}

export function selectOpenMainRedIssues(issues) {
  return issues.filter((issue) => issue.state === "open" && issue.pull_request === undefined &&
    issue.labels.some((label) => (typeof label === "string" ? label : label.name) === mainRedLabel));
}

export function isIssueForHeadSha(issue, headSha) {
  return typeof issue.body === "string" && issue.body.includes(mainRedShaMarker(headSha));
}

export function isStaleMainRedRun(issue, runId) {
  const recordedRunId = readMainRedRunId(issue);
  return recordedRunId !== null && recordedRunId > Number(runId);
}
