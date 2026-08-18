#!/usr/bin/env node
// Seed-container entrypoint: create the harness-ized test project, write real
// ledger content (task, decision, fact, progress), push the canonical ledger to
// GitLab, and mint the fleet TLS material + roster shared with center/edges.
// The GitLab token arrives as GITLAB_TOKEN env only; it never lands in a file
// tracked by this repo or in an image layer.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TESTBED, fail, fleetEnv, gitCredentialArgs, ha, harnessEnv, log, mustRun, startDaemon } from "./lib/testbed.mjs";

const workspace = "/data/workspace";
const userRoot = "/data/daemon-user";
const sharedFleet = path.join(TESTBED.sharedRoot, "fleet");
const edges = ["edge-1", "edge-2"];
const taskTitle = "Prove the center ledger read chain";

await main();

async function main() {
  const token = process.env.GITLAB_TOKEN;
  if (!token) fail("env", "GITLAB_TOKEN is required (export GITLAB_TOKEN=$(cat ~/.harness-secrets-center-testbed-token)).");
  resetState();
  const daemon = startDaemon("seed", userRoot, "seed");
  const seed = seedLedger();
  const project = await ensureGitLabProject(token);
  pushLedgerToGitLab(project, token);
  const fleet = mintFleetMaterial(seed);
  writeStateFile(seed, project, fleet);
  log("seed", `bootstrap complete; shared state at ${TESTBED.stateFile}`);
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 10_000);
    daemon.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    daemon.kill("SIGTERM");
  });
}

function resetState() {
  // The workspace is a compose volume mount, so its contents are wiped
  // entry-by-entry rather than removing the mountpoint itself. The shared
  // volume is NOT wiped: center/edge containers may be reading it while a
  // reseed runs, so every shared file is replaced atomically below instead.
  if (existsSync(workspace)) for (const entry of readdirSync(workspace)) rmSync(path.join(workspace, entry), { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  rmSync(userRoot, { recursive: true, force: true });
}

function seedLedger() {
  const env = fleetEnv(userRoot, "seed");
  const root = ["--root", workspace];
  const init = ha("init", env, [...root, "init", "--repo-id", TESTBED.repoId, "--person-id", TESTBED.personId, "--display-name", "PLT Center Testbed Owner", "--name", "plt-center-testbed"]);
  log("init", `harness initialized, commit ${init.commit}`);

  const task = ha("task-create", env, [...root, "task", "create", "--title", taskTitle, "--preset", "standard-task"]);
  log("task-create", `task ${task.taskId} created (${task.packagePath})`);
  const executionId = "exe-testbed-center-1";
  ha("task-start", env, [...root, "task", "start", task.taskId, "--execution-id", executionId]);
  log("task-start", `execution ${executionId} started`);

  const packet = JSON.stringify({
    title: "Testbed ledger authority sits on the center daemon",
    question: "Where does the PLT-Center testbed ledger authority live?",
    riskTier: "medium", urgency: "medium", vertical: "default", preset: "default", decisionClass: "ordinary",
    appliesTo: { modules: [], productLines: [] },
    chosen: [{ id: "CH1", text: "The center daemon is the single writer; edges consume replica cuts." }],
    rejected: [{ id: "RJ1", text: "Edges write directly to the GitLab remote", whyNot: "M2 forbids edge direct writes to the canonical ledger." }],
    claims: [], fulfillments: [], relations: []
  });
  const body = "# Testbed decision\n\nThe center daemon owns the canonical ledger. Edge nodes read replica cuts over fleet TLS and must not write the canonical ledger directly.";
  const decision = ha("decision-propose", env, [...root, "decision", "propose", "--json-input", packet, "--body", body]);
  log("decision-propose", `decision written at ${decision.path}`);

  ha("fact-record", env, [...root, "fact", "record", "--task", task.taskId, "--statement", "The testbed bootstrap wrote a task, a decision, and a fact into the canonical center ledger before pushing it to GitLab.", "--source", "tools/center-testbed/bootstrap.mjs", "--confidence", "high"]);
  ha("progress-append", env, [...root, "task", "progress", "append", task.taskId, "--text", "Seed bootstrap finished: ledger content ready for the center daemon to attach and republish."]);
  log("writes", "task, execution, decision, fact, and progress entries committed to the ledger");

  mustRun("wrapper", "git", ["-C", workspace, "add", "-A"], { env: harnessEnv() });
  mustRun("wrapper", "git", ["-C", workspace, "-c", `user.name=${TESTBED.gitAuthor.name}`, "-c", `user.email=${TESTBED.gitAuthor.email}`, "commit", "-q", "-m", "Testbed project wrapper"], { env: harnessEnv() });
  const ledger = path.join(workspace, "harness");
  const canonicalHead = mustRun("revision", "git", ["-C", ledger, "rev-parse", "refs/ha/canonical"], { env: harnessEnv() }).trim();
  const seedRevision = JSON.parse(readFileSync(path.join(ledger, "events/head.json"), "utf8")).revision;
  return { taskId: task.taskId, executionId, packagePath: task.packagePath, title: taskTitle, decisionPath: decision.path, canonicalHead, seedRevision };
}

async function ensureGitLabProject(token) {
  const headers = { "PRIVATE-TOKEN": token, "content-type": "application/json" };
  const encoded = encodeURIComponent(`root/${TESTBED.gitlabProject}`);
  let response = await gitlab(`projects/${encoded}`, { headers, redirect: "manual" });
  if (response.status === 301) {
    // A prior deletion attempt leaves a renamed tombstone that still owns the
    // path (purge is adjourned server-side and not forceable through the API).
    // Restoring reclaims the exact path; the force-push then replaces content.
    const tombstone = await (await gitlab(`projects/${encoded}`, { headers })).json();
    if (!tombstone?.marked_for_deletion_on) fail("gitlab", `path root/${TESTBED.gitlabProject} is taken by ${tombstone?.path_with_namespace ?? "an unknown project"} that is not a restorable tombstone.`);
    const restored = await gitlab(`projects/${tombstone.id}/restore`, { method: "POST", headers });
    if (restored.status >= 300) fail("gitlab", `restoring the tombstoned project failed: HTTP ${restored.status}`);
    log("gitlab", `restored tombstoned project ${tombstone.path_with_namespace} back to root/${TESTBED.gitlabProject}`);
    response = await gitlab(`projects/${encoded}`, { headers, redirect: "manual" });
  }
  if (response.status === 200) {
    const project = await response.json();
    log("gitlab", `reusing project ${project.path_with_namespace}; refs will be force-pushed for the reseed`);
    await allowForcePush(project.id, headers);
    return project;
  }
  if (response.status !== 404) fail("gitlab", `project lookup failed: HTTP ${response.status}`);
  const created = await gitlab("projects", { method: "POST", headers, body: JSON.stringify({ name: TESTBED.gitlabProject, path: TESTBED.gitlabProject, visibility: "private", default_branch: "main" }) });
  if (created.status !== 201) fail("gitlab", `project creation failed: HTTP ${created.status} ${(await created.text()).slice(0, 500)}`);
  const project = await created.json();
  await allowForcePush(project.id, headers);
  log("gitlab", `project ready at ${project.web_url}`);
  return project;
}

// Reseeding replaces ledger history, and GitLab protects the default branch
// against force pushes out of the box; drop that protection on the test
// project only (a project-level setting, not a server-level change).
async function allowForcePush(projectId, headers) {
  const removed = await gitlab(`projects/${projectId}/protected_branches/main`, { method: "DELETE", headers });
  if (removed.status !== 204 && removed.status !== 404) fail("gitlab", `could not unprotect main for reseeding: HTTP ${removed.status}`);
  log("gitlab", "branch main unprotected so reseeds can force-push");
}

function pushLedgerToGitLab(project, token) {
  const ledger = path.join(workspace, "harness");
  mustRun("push", "git", ["-C", ledger, ...gitCredentialArgs(), "push", "--force", project.http_url_to_repo, "refs/heads/main:refs/heads/main", "refs/ha/canonical:refs/ha/canonical"], { env: harnessEnv({ GITLAB_TOKEN: token }) });
  log("push", `ledger pushed to ${project.http_url_to_repo}`);
}

function mintFleetMaterial(seed) {
  mkdirSync(sharedFleet, { recursive: true });
  const key = path.join(sharedFleet, "fleet.key"), cert = path.join(sharedFleet, "fleet.crt");
  const keyStaging = `${key}.staging`, certStaging = `${cert}.staging`;
  mustRun("tls", "openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyStaging, "-out", certStaging, "-subj", "/CN=center", "-days", "30", "-addext", "subjectAltName=DNS:center,DNS:localhost,IP:127.0.0.1"]);
  renameSync(keyStaging, key);
  renameSync(certStaging, cert);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const roster = {
    schema: "fleet-roster/v1",
    nodes: edges.map((nodeId) => ({ nodeId, credential: `${nodeId}-machine-secret` })),
    assignments: edges.map((nodeId) => ({
      assignmentId: `assignment-${nodeId}`, nodeId, repoId: TESTBED.repoId, taskId: seed.taskId, executionId: seed.executionId,
      viewId: `${nodeId}-view`, personId: TESTBED.personId, executorId: "plt-center-testbed", expiresAt,
      paths: [`${seed.packagePath}/task_plan.md`, seed.decisionPath]
    }))
  };
  const rosterStaging = path.join(sharedFleet, "roster.json.staging");
  writeFileSync(rosterStaging, `${JSON.stringify(roster, null, 2)}\n`);
  renameSync(rosterStaging, path.join(sharedFleet, "roster.json"));
  log("fleet", `TLS material + roster for ${roster.nodes.length} nodes written to ${sharedFleet}`);
  return { roster, expiresAt };
}

function writeStateFile(seed, project, fleet) {
  const state = {
    schema: "center-testbed-state/v1",
    repoId: TESTBED.repoId,
    taskId: seed.taskId,
    executionId: seed.executionId,
    packagePath: seed.packagePath,
    taskTitle: seed.title,
    decisionPath: seed.decisionPath,
    canonicalHead: seed.canonicalHead,
    seedRevision: seed.seedRevision,
    gitlab: { url: TESTBED.gitlabUrl, projectId: project.id, pathWithNamespace: project.path_with_namespace, webUrl: project.web_url, httpUrl: project.http_url_to_repo },
    fleet: { port: TESTBED.fleetPort, quotaBytes: TESTBED.fleetQuotaBytes, rosterPath: path.join(sharedFleet, "roster.json"), certPath: path.join(sharedFleet, "fleet.crt"), nodes: fleet.roster.nodes.map(({ nodeId }) => nodeId), expiresAt: fleet.expiresAt }
  };
  const stateStaging = `${TESTBED.stateFile}.staging`;
  writeFileSync(stateStaging, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(stateStaging, TESTBED.stateFile);
}

async function gitlab(pathname, init = {}) {
  try {
    return await fetch(new URL(pathname, `${TESTBED.gitlabUrl}/api/v4/`), { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    fail("gitlab", `request to ${pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
