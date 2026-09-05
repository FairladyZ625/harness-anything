import { copyFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openFleetCampaignFixture } from "./fleet-fixture.mjs";

const controlRoot = path.resolve(process.argv[2] ?? "/tmp/harness-s4-operator-center"),
  fixture = await openFleetCampaignFixture({
    repoNames: ["seed-1", "seed-2", "seed-3"],
    bind: "0.0.0.0",
    port: 7443,
  }),
  center = await fixture.startCenter("operator-center"),
  roster = {
    schema: "fleet-roster/v2",
    nodes: Array.from({ length: 8 }, (_value, index) => ({
      nodeId: `edge-${index + 1}`,
      credential: `credential-edge-${index + 1}`,
    })),
    assignments: fixture.assignments.map((assignment) => ({
      assignmentId: assignment.assignmentId,
      nodeId: assignment.nodeId,
      repoId: assignment.repoId,
      viewId: assignment.viewId,
      personId: assignment.actor.principal.personId,
      executorId: assignment.actor.executor.id,
      expiresAt: assignment.expiresAt,
      scope: assignment.scope,
    })),
  };

mkdirSync(controlRoot, { recursive: true });
copyFileSync(fixture.certFile, path.join(controlRoot, "server.crt"));
writeJson(path.join(controlRoot, "fleet-roster.json"), roster);

for (const repo of fixture.repos) {
  const created = await fixture.schedule(fixture.assignment(repo.repoId, 0), `operator-create-${repo.repoId}`, {
    kind: "schedule-create",
    scheduleId: "campaign",
    name: "S4 operator campaign",
    mode: "remediate",
    everyMs: 300_000,
    agentId: "campaign-agent",
    runtimeInstanceId: "stress-runtime",
    mission: "Expose live fleet progress to the operator GUI.",
  });
  if (created.outcome !== "applied") throw new Error(`schedule create failed for ${repo.repoId}`);
}

let tick = 0;
const statusPath = path.join(controlRoot, "status.json"),
  updateStatus = () =>
    writeJson(statusPath, {
      schema: "s4-operator-center-status/v1",
      pid: process.pid,
      host: "0.0.0.0",
      port: center.port,
      servername: "localhost",
      certificate: path.join(controlRoot, "server.crt"),
      roster: path.join(controlRoot, "fleet-roster.json"),
      repoIds: fixture.repos.map(({ repoId }) => repoId),
      revisions: Object.fromEntries(
        fixture.repos.map(({ repoId }) => [repoId, fixture.host.replica(repoId).ledgerCut()?.revision ?? 0]),
      ),
      tick,
      updatedAt: new Date().toISOString(),
    });

updateStatus();
const timer = setInterval(async () => {
  tick += 1;
  try {
    const receipts = await Promise.all(
      fixture.repos.map((repo) =>
        fixture.schedule(fixture.assignment(repo.repoId, 0), `operator-tick-${repo.repoId}-${tick}`, {
          kind: "schedule-update",
          scheduleId: "campaign",
          name: `S4 operator campaign tick ${tick}`,
        }),
      ),
    );
    if (receipts.some(({ outcome }) => outcome !== "applied"))
      throw new Error(`operator tick ${tick} was not applied: ${JSON.stringify(receipts)}`);
    updateStatus();
  } catch (error) {
    writeFileSync(
      path.join(controlRoot, "error.log"),
      `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`,
      { flag: "a" },
    );
  }
}, 15_000);

const close = async () => {
  clearInterval(timer);
  await fixture.close();
  process.exit(0);
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
await new Promise(() => undefined);

function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}
