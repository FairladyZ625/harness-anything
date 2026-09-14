// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseCanonicalEvent, serializeCanonicalEvent } from "../../packages/kernel/src/index.ts";
import {
  assessConnections,
  assessHelloLatency,
  assessRssTrend,
  assessWorkload,
  createSoakEvents,
  recordLoadFailure,
  renderDaemonOutput,
} from "./daemon-soak.mjs";
import { daemonServeLaunch, waitForAttachedRepo } from "./daemon-soak-support.mjs";

test("scale ledger generator emits the requested valid event and task counts", () => {
  const events = createSoakEvents({ taskCount: 3, eventCount: 12 });
  assert.equal(events.length, 12);
  assert.equal(events.filter(({ type }) => type === "task_created").length, 3);
  assert.equal(events.filter(({ type }) => type === "runtime_session_started").length, 1);
  for (const event of events) assert.deepEqual(parseCanonicalEvent(serializeCanonicalEvent(event)), event);
});

test("bounded connection assessment rejects the historical reconnect storm", () => {
  const stable = assessConnections({
    normal: { growth: { startedMinute: null }, connections: { opened: 120, closed: 120, stillOpen: 0 } },
    fault: { connections: { opened: 5, closed: 5, stillOpen: 0 } },
    maxFaultConnections: 6,
  });
  assert.equal(stable.ok, true, stable.message);

  const storm = assessConnections({
    normal: { growth: { startedMinute: null }, connections: { opened: 120, closed: 120, stillOpen: 0 } },
    fault: { connections: { opened: 244, closed: 244, stillOpen: 0 } },
    maxFaultConnections: 6,
  });
  assert.equal(storm.ok, false);
  assert.match(storm.message, /bounded connections.*244 > 6/u);
});

test("hello assessment uses client end-to-end P99 as well as daemon dispatch P99", () => {
  const daemon = { methods: [{ method: "protocol.hello", p99Ms: 8 }] };
  assert.equal(assessHelloLatency({ clientSamplesMs: [8, 9, 10, 11, 12], daemon, maxP99Ms: 250 }).ok, true);
  const blocked = assessHelloLatency({ clientSamplesMs: [8, 9, 10, 11, 900], daemon, maxP99Ms: 250 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /client P99 900ms > 250ms/u);
});

test("RSS assessment accepts a plateau and rejects sustained monotonic growth", () => {
  const mib = 1024 * 1024;
  const plateau = [100, 102, 101, 103, 102, 101, 102, 102].map((rss, index) => ({
    atMs: index * 10_000,
    rssBytes: rss * mib,
  }));
  assert.equal(
    assessRssTrend({ samples: plateau, maxGrowthBytes: 16 * mib, maxSlopeBytesPerMinute: 8 * mib }).ok,
    true,
  );

  const climb = [100, 110, 120, 130, 140, 150, 160, 170].map((rss, index) => ({
    atMs: index * 10_000,
    rssBytes: rss * mib,
  }));
  const result = assessRssTrend({ samples: climb, maxGrowthBytes: 16 * mib, maxSlopeBytesPerMinute: 8 * mib });
  assert.equal(result.ok, false);
  assert.match(result.message, /RSS trend/u);
});

test("workload failures retain bounded, self-explanatory evidence", () => {
  const counts = { requests: 3, failures: 3, failureEvidence: [], failureEvidenceDropped: 0, failureEvidenceLimit: 2 },
    startedAt = performance.now();
  for (const method of ["repo.tasks.list", "protocol.hello", "daemon.status"])
    recordLoadFailure({
      counts,
      method,
      startedAt,
      failure: Object.assign(new Error("the daemon did not answer within 5s"), { code: "daemon_response_timeout" }),
    });
  assert.equal(counts.failureEvidence.length, 2);
  assert.equal(counts.failureEvidenceDropped, 1);
  assert.match(
    counts.failureEvidence[0],
    /^t\+\d+ms repo\.tasks\.list failed: code=daemon_response_timeout; the daemon did not answer within 5s$/u,
  );
  const assessment = assessWorkload(counts);
  assert.equal(assessment.ok, false);
  assert.match(assessment.message, /protocol\.hello failed/u);
  assert.match(
    assessment.message,
    /failure evidence truncated: 1 additional failure\(s\) omitted after 2 record\(s\)/u,
  );
});

test("daemon output artifact declares that a normal empty stdio capture is expected", () => {
  const output = renderDaemonOutput([]);
  assert.match(output, /captured daemon stdout\/stderr: 0 byte\(s\)/u);
  assert.match(output, /This capture is working/u);
});

test("daemon launch spawns the published daemon host entry with the product argument shape", () => {
  const launch = daemonServeLaunch({
    userRoot: "/tmp/soak-user",
    daemonId: "nightly-soak-1",
    home: "/tmp/soak-home",
    env: {
      PATH: "/usr/bin",
      HARNESS_DAEMON_USER_ROOT: "/tmp/leaked",
      HARNESS_DAEMON_ID: "leaked",
      HARNESS_DAEMON_ENDPOINT: "/tmp/leaked.sock",
      HARNESS_ACTOR: "leaked-actor",
      OPENAI_API_KEY: "leaked-key",
    },
  });
  assert.equal(launch.command, process.execPath);
  assert.match(launch.args[0], /packages\/daemon\/src\/bin\.ts$/u);
  assert.deepEqual(launch.args.slice(1), ["serve", "--user-root", "/tmp/soak-user", "--daemon-id", "nightly-soak-1"]);
  assert.equal(launch.env.HOME, "/tmp/soak-home");
  assert.equal(launch.env.USERPROFILE, "/tmp/soak-home");
  assert.equal(launch.env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(launch.env.PATH, "/usr/bin");
  for (const key of [
    "HARNESS_DAEMON_USER_ROOT",
    "HARNESS_DAEMON_ID",
    "HARNESS_DAEMON_ENDPOINT",
    "HARNESS_ACTOR",
    "OPENAI_API_KEY",
  ])
    assert.equal(launch.env[key], undefined, `${key} must not leak into the daemon child`);
});

test("a daemon that exits during startup carries its captured exit reason into the attach failure", async () => {
  const child = { exitCode: 2, stdout: null, stderr: null },
    chunk = '{"code":"unsupported_command"}\n';
  await assert.rejects(
    waitForAttachedRepo({
      child,
      endpoint: "/tmp/unused.sock",
      repoId: "nightly-soak",
      timeoutMs: 1_000,
      describeDaemonOutput: () => renderDaemonOutput([chunk]),
    }),
    (error) => {
      assert.match(error.message, /daemon exited during startup with code 2/u);
      assert.match(
        error.message,
        new RegExp(`captured daemon stdout/stderr: ${Buffer.byteLength(chunk)} byte\\(s\\)`, "u"),
      );
      assert.match(error.message, /unsupported_command/u);
      return true;
    },
  );
  await assert.rejects(
    waitForAttachedRepo({ child, endpoint: "/tmp/unused.sock", repoId: "nightly-soak", timeoutMs: 1_000 }),
    /daemon exited during startup with code 2\n?$/u,
  );
});
