// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createDaemonHostRepositoryApi } from "../src/daemon-host-repository-api.ts";
import type { DaemonHostApiContext } from "../src/daemon-host-context.ts";

for (const kind of ["task-submit", "schedule-disable"]) {
  test(`${kind} returns its durable receipt while scheduler refresh is pending`, async () => {
    let release!: () => void,
      refreshed = 0;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const receipt = { outcome: "applied", evidence: "durable" };
    const context = {
      admitHostMode: () => ({ ok: true }),
      attemptHostRecovery: async () => {},
      cells: new Map([
        [
          "probe",
          {
            status: () => ({ mode: "local", rootDir: "/unused" }),
            run: async () => receipt,
          },
        ],
      ]),
      binding: async () => ({ actor: { principal: { personId: "probe" }, executor: null }, source: "local" }),
      scheduleScheduler: {
        refresh: () => {
          refreshed += 1;
          return pending;
        },
      },
    } as unknown as DaemonHostApiContext;
    let returned = false;
    const reply = createDaemonHostRepositoryApi(context)
      .run("probe", { kind }, {} as never)
      .then((value) => {
        returned = true;
        return value;
      });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(refreshed, 1);
      assert.equal(returned, true, "reply must not wait for unrelated scheduler work");
      assert.equal(await reply, receipt);
    } finally {
      release();
      await reply;
    }
  });
}
