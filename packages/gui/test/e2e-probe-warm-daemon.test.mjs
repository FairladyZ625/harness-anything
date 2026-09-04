// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { warmDaemonProjection } from "../../../tools/e2e-probe.mjs";
import { assertCanonicalDaemonMethods } from "../../../tools/gui-e2e/lanes.mjs";

const ready = { evidence: JSON.stringify({ status: "ready" }) };
const pending = { evidence: JSON.stringify({ status: "pending" }) };
const noSleep = async () => undefined;

test("warmDaemonProjection returns once the projection reports ready", async () => {
  const seen = [pending, pending, ready];
  let call = 0;
  const outcome = await warmDaemonProjection({
    readProjection: () => Promise.resolve(seen[call++]),
    sleep: noSleep,
  });
  assert.deepEqual(outcome, { attempts: 3, status: "ready" });
  assert.equal(call, 3, "the warm-up kept polling until the projection caught up");
});

test("warmDaemonProjection fails fast when the canonical daemon reports build drift", async () => {
  let call = 0;
  await assert.rejects(
    warmDaemonProjection({
      readProjection: () => {
        call += 1;
        return Promise.resolve({
          ...ready,
          daemonBuild: {
            code: "daemon_build_stale",
            loadedBuildId: "loaded-old",
            diskBuildId: "disk-new",
          },
        });
      },
      sleep: noSleep,
    }),
    (error) => {
      assert.equal(error.code, "daemon_build_stale");
      assert.match(error.message, /daemon build loaded-old/u);
      assert.match(error.message, /disk build is disk-new/u);
      return true;
    },
  );
  assert.equal(call, 1, "build drift must stop before projection retries or GUI launch");
});

test("warmDaemonProjection ignores daemon-only method growth when no build drift is reported", async () => {
  const outcome = await warmDaemonProjection({
    readProjection: () => Promise.resolve({ ...ready, daemonMethods: ["daemon.extra.method"] }),
    sleep: noSleep,
  });
  assert.deepEqual(outcome, { attempts: 1, status: "ready" });
});

test("canonical method preflight rejects only GUI-required methods missing from the daemon", () => {
  assert.throws(
    () =>
      assertCanonicalDaemonMethods({
        daemonMethods: ["protocol.hello", "daemon.extra"],
        requiredMethods: ["protocol.hello", "repo.gui.new-read"],
        daemonCommit: "daemon-old",
        guiCommit: "gui-new",
      }),
    (error) => {
      assert.equal(error.code, "daemon_gui_method_drift");
      assert.match(error.message, /repo\.gui\.new-read/u);
      assert.match(error.message, /daemon-old.*gui-new/u);
      return true;
    },
  );
  assert.doesNotThrow(() =>
    assertCanonicalDaemonMethods({
      daemonMethods: ["protocol.hello", "daemon.extra"],
      requiredMethods: ["protocol.hello"],
      daemonCommit: "daemon-new",
      guiCommit: "gui-old",
    }),
  );
});

test("warmDaemonProjection tolerates transient read failures before ready", async () => {
  let call = 0;
  const outcome = await warmDaemonProjection({
    readProjection: () => {
      call += 1;
      if (call === 1) throw new Error("daemon starting");
      return Promise.resolve(ready);
    },
    sleep: noSleep,
  });
  assert.deepEqual(outcome, { attempts: 2, status: "ready" });
});

test("warmDaemonProjection fails closed with a diagnosable code when never ready", async () => {
  let call = 0;
  await assert.rejects(
    warmDaemonProjection({
      attempts: 4,
      readProjection: () => {
        call += 1;
        return Promise.resolve(pending);
      },
      sleep: noSleep,
    }),
    (error) => {
      assert.equal(error.code, "daemon_projection_unready");
      assert.match(error.message, /projection status pending/u);
      return true;
    },
  );
  assert.equal(call, 4, "the warm-up exhausted exactly its attempt budget");
});

test("warmDaemonProjection never sleeps after its final attempt", async () => {
  let sleeps = 0;
  await assert.rejects(
    warmDaemonProjection({
      attempts: 3,
      readProjection: () => Promise.resolve(pending),
      sleep: async () => {
        sleeps += 1;
      },
    }),
    { code: "daemon_projection_unready" },
  );
  assert.equal(sleeps, 2, "N attempts wait at most N-1 times between reads");
});
