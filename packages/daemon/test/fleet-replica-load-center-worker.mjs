import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";

const hooks = [];
let fixture;
let resourceTimer;
let priorCpu = process.cpuUsage();
let priorAt = Date.now();

try {
  fixture = await fleetNodeClaimFixture({ after: (callback) => hooks.push(callback) });
  const center = fixture.center;
  process.send({
    type: "ready",
    port: center.port,
    repoId: "lease-repo",
    repoRoot: fixture.repo,
    certPath: `${fixture.root}/tls.crt`,
    keycloakUrl: fixture.owners.url,
    baseRevision: fixture.eventCount(),
    rssBytes: process.memoryUsage.rss(),
  });
  resourceTimer = setInterval(() => {
    const at = Date.now(),
      cpu = process.cpuUsage(priorCpu),
      elapsed = Math.max(1, at - priorAt);
    priorCpu = process.cpuUsage();
    priorAt = at;
    process.send({
      type: "resource",
      sample: {
        sampledAt: at,
        cpuPercent: (cpu.user + cpu.system) / (elapsed * 1_000),
        rssBytes: process.memoryUsage.rss(),
      },
    });
  }, 500);
  process.on("message", async (message) => {
    if (message.type === "stop") {
      clearInterval(resourceTimer);
      try {
        await fixture.close();
        process.exit(0);
      } catch (error) {
        process.send({ type: "startup-error", error: error instanceof Error ? error.stack : String(error) });
        process.exit(1);
      }
      return;
    }
    try {
      if (message.type === "register") {
        fixture.owners.reassign(message.nodeId, "person-one");
        process.send({ type: "response", id: message.id, value: { registered: true } });
      } else if (message.type === "write") {
        const writeStartedAt = Date.now();
        const receipt = await fixture.host.run(
          "lease-repo",
          {
            kind: "task-create",
            taskId: `fleet-stress-${message.sequence}`,
            title: `Fleet sustained write ${message.sequence}`,
          },
          fixture.owners.auth({ nodeId: "center-node" }),
        );
        if (receipt.outcome !== "applied") throw new Error(`center write rejected: ${JSON.stringify(receipt)}`);
        const value = {
          sequence: message.sequence,
          writeStartedAt,
          writtenAt: Date.now(),
          revision: fixture.eventCount(),
          opId: receipt.opId,
        };
        process.send({ type: "response", id: message.id, value });
      }
    } catch (error) {
      process.send({ type: "response", id: message.id, error: error instanceof Error ? error.stack : String(error) });
    }
  });
} catch (error) {
  process.send({ type: "startup-error", error: error instanceof Error ? error.stack : String(error) }, () =>
    process.exit(1),
  );
}
