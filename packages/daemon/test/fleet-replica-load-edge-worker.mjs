import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { managedRbacSessionStore } from "../src/managed-rbac-service.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";

const config = JSON.parse(process.env.FLEET_WORKER_CONFIG);
const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-load-edge-"));
const repoRoot = path.join(root, "repo"),
  userRoot = path.join(root, "user"),
  viewRoot = path.join(root, "view");
let host;
let pollTimer;
const targets = new Map(),
  seen = new Map();
let lastReportedRevision = -1;

try {
  mkdirSync(path.join(repoRoot, "harness"), { recursive: true });
  writeFileSync(
    path.join(repoRoot, "harness", "harness.yaml"),
    readFileSync(path.join(config.repoRoot, "harness", "harness.yaml")),
  );
  execFileSync("git", ["init", "-q", repoRoot]);
  execFileSync("git", ["-C", repoRoot, "add", "harness"]);
  execFileSync("git", [
    "-C",
    repoRoot,
    "-c",
    "user.name=Fleet Load Edge",
    "-c",
    "user.email=fleet-load@example.invalid",
    "commit",
    "-qm",
    "edge workspace",
  ]);
  mkdirSync(path.join(userRoot, "rbac"), { recursive: true });
  managedRbacSessionStore(userRoot).write(
    JSON.stringify({
      schema: "harness-oidc-session/v2",
      accessToken: `device-token-${config.nodeId}`,
      refreshToken: `refresh-${config.nodeId}`,
      subject: "person-one",
      personId: "person-one",
      expiresAt: Date.now() + 3_600_000,
      sessionExpiresAt: Date.now() + 21_600_000,
      roles: [],
      loginTarget: repoRoot,
      authority: { url: config.keycloakUrl, realm: "harness" },
    }),
  );
  registerBootstrappedDaemonRepo({
    repoId: config.repoId,
    canonicalRoot: repoRoot,
    userRoot,
    mode: "remote-edge",
    createConvenienceLinks: false,
  });
  writeFileSync(
    path.join(repoRoot, "fleet-edge.json"),
    JSON.stringify({
      schema: "fleet-edge-config/v1",
      repoId: config.repoId,
      host: "127.0.0.1",
      port: config.centerPort,
      servername: "localhost",
      caPath: config.certPath,
      nodeId: config.nodeId,
      credential: `secret-${config.nodeId}`,
      viewRoot,
      quotaBytes: 64 * 1024 * 1024,
      waitTimeoutMs: 2_000,
    }),
  );
  host = await openDaemonHost({
    daemonId: `${config.nodeId}-daemon`,
    userRoot,
    oidc: new OidcSessionService(userRoot),
  });
  await host.attachmentsSettled();
  process.send({ type: "ready", nodeId: config.nodeId, rssBytes: process.memoryUsage.rss() });
  pollTimer = setInterval(sampleCut, 10);
  process.on("message", (message) => {
    if (message.type === "target") {
      targets.set(message.revision, {
        revision: message.revision,
        writtenAt: message.writtenAt,
        sequence: message.sequence,
      });
      reportArrivals();
    } else if (message.type === "stop") void stop();
  });
} catch (error) {
  process.send({ type: "startup-error", error: error instanceof Error ? error.stack : String(error) }, () =>
    process.exit(1),
  );
}

function sampleCut() {
  try {
    const viewsRoot = path.join(viewRoot, "repos", config.repoId, "views");
    for (const viewId of readdirSync(viewsRoot)) {
      const currentPath = path.join(viewsRoot, viewId, "current.json");
      const current = JSON.parse(readFileSync(currentPath, "utf8"));
      const revision = current.cut.revision;
      if (!Number.isInteger(revision)) continue;
      const sampledAt = Date.now();
      seen.set(revision, sampledAt);
      const oldRevisions = [...seen.keys()].filter((item) => item < revision - 2);
      for (const oldRevision of oldRevisions) seen.delete(oldRevision);
      if (revision !== lastReportedRevision) {
        lastReportedRevision = revision;
        process.send({ type: "progress", nodeId: config.nodeId, revision, sampledAt });
      }
      reportArrivals(revision, sampledAt);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function reportArrivals(currentRevision, sampledAt) {
  const observedRevision = currentRevision ?? Math.max(-1, ...seen.keys()),
    observedAt = sampledAt ?? seen.get(observedRevision);
  if (observedAt === undefined) return;
  for (const [revision, target] of targets) {
    if (revision > observedRevision) continue;
    targets.delete(revision);
    process.send({
      type: "arrival",
      nodeId: config.nodeId,
      revision,
      sequence: target.sequence,
      writtenAt: target.writtenAt,
      arrivedAt: observedAt,
    });
  }
}

async function stop() {
  clearInterval(pollTimer);
  try {
    await host.close();
    rmSync(root, { recursive: true, force: true });
    process.exit(0);
  } catch (error) {
    process.send({ type: "startup-error", error: error instanceof Error ? error.stack : String(error) });
    process.exit(1);
  }
}
