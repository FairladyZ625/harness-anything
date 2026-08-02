// This module is the tested oracle for the inline github-script body in
// .github/workflows/main-red-notify.yml. The workflow deliberately does not check out the
// repository (workflow_run runs with issues: write, and a checkout there widens the attack
// surface), so its logic must stay inline and cannot import this file. main-red-notify.test.mjs
// keeps the two in parity by executing the extracted inline script against these builders.
//
// Per-workflow identity exists because main-red-notify watches more than one workflow. While
// they shared a single advisory issue, a green rewrite-ci run closed the red that
// nightly-integration had opened, under a title naming rewrite-ci — so a tier that was red for
// two weeks was reported daily under the wrong name and silenced within the hour.
// See dec_01KZ20MPDZH490AXKQX3VC1NEG.
//
// Identity is the numeric workflow_id, not the display name: a name is editable (renaming a
// workflow would strand its open issue forever) and lossy to slugify (two names differing only
// in punctuation would collide and close each other's issues). The name is display only.
const notificationMarker = "<!-- main-red-notification -->";

function cleanInline(value) {
  return String(value).replace(/[\r\n]+/gu, " ").trim();
}

export const mainRedLabel = "main-red";

// Defensive: the identity is embedded in an HTML comment marker, so it must not be able to
// terminate one even if the payload is not the expected numeric id.
export function mainRedWorkflowIdentity(workflowId) {
  return cleanInline(workflowId).replace(/[^A-Za-z0-9._-]+/gu, "-") || "unknown-workflow";
}

export function mainRedWorkflowMarker(workflowId) {
  return `<!-- main-red-workflow:${mainRedWorkflowIdentity(workflowId)} -->`;
}

// null means "this issue declares no owner". Issues opened before per-workflow identity are the
// only such issues, and they are NOT attributed by guesswork: the shared issue carried a
// rewrite-ci title no matter which workflow had failed, so assuming rewrite-ci owns it would
// reproduce exactly the wrong-workflow closure this change exists to remove. They are left for
// a human, which is visible, rather than closed by the wrong workflow, which is not.
export function readMainRedWorkflowIdentity(issue) {
  const match = typeof issue.body === "string" ? issue.body.match(/<!-- main-red-workflow:([A-Za-z0-9._-]+) -->/u) : null;
  return match === null ? null : match[1];
}

export function mainRedIssueTitle(workflowName) {
  return `[CI] ${cleanInline(workflowName)} is red on main`;
}

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

export function buildMainRedIssueBody({ workflowId, workflowName, runId, runUrl, headSha, failedJobs }) {
  const workflow = cleanInline(workflowName);
  const jobs = [...new Set(failedJobs.map(cleanInline).filter(Boolean))];
  const jobLines = jobs.length > 0 ? jobs.map((name) => `- ${name}`) : ["- Unable to identify a failed job from the run API."];
  return [
    notificationMarker,
    mainRedWorkflowMarker(workflowId),
    mainRedRunMarker(runId),
    mainRedShaMarker(headSha),
    `## ${workflow} is red on main`,
    "",
    `- Workflow: ${workflow}`,
    `- Run: ${cleanInline(runUrl)}`,
    `- Head SHA: \`${cleanInline(headSha)}\``,
    "- Failed jobs:",
    ...jobLines,
    "",
    "This issue is advisory only. It does not change required checks, branch protection, or merge enforcement.",
    `Only a later green ${workflow} run closes it; other watched workflows keep their own advisory issues.`
  ].join("\n");
}

export function buildMainRedRecoveryComment({ workflowName, runUrl, headSha }) {
  return `${cleanInline(workflowName)} is green again on main for \`${cleanInline(headSha)}\`: ${cleanInline(runUrl)}. Closing this advisory issue.`;
}

export function selectOpenMainRedIssues(issues) {
  return issues.filter((issue) => issue.state === "open" && issue.pull_request === undefined &&
    issue.labels.some((label) => (typeof label === "string" ? label : label.name) === mainRedLabel));
}

// A workflow only ever reads, updates, or closes the advisory issue it owns. Without this
// filter one watched workflow's green run retires another's red.
export function selectWorkflowMainRedIssues(issues, workflowId) {
  const identity = mainRedWorkflowIdentity(workflowId);
  return selectOpenMainRedIssues(issues).filter((issue) => readMainRedWorkflowIdentity(issue) === identity);
}

export function isIssueForHeadSha(issue, headSha) {
  return typeof issue.body === "string" && issue.body.includes(mainRedShaMarker(headSha));
}

// Strictly greater-than. A re-run keeps the same run id, so treating an equal id as stale would
// leave the advisory issue open forever after "run N failed, run N re-run succeeded".
export function isStaleMainRedRun(issue, runId) {
  const recordedRunId = readMainRedRunId(issue);
  return recordedRunId !== null && recordedRunId > Number(runId);
}
