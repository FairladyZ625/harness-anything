// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createDaemonHostRepositoryApi } from "../src/daemon-host/daemon-host-repository-api.ts";
import type { DaemonHostApiContext } from "../src/daemon-host/daemon-host-context.ts";
import {
  code,
  daemonErrorMessage,
  diagnosticForError,
  hostCodedError,
  rejectHostAction,
} from "../src/daemon-host/daemon-host-errors.ts";

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

test("the host preserves scope guidance when a node's consent is rejected before the cell runs", async (t) => {
  const cause = "Only the center writer can confirm this cut.",
    context = {
      admitHostMode: () => ({ ok: true }),
      attemptHostRecovery: async () => {},
      cells: new Map([["probe", { status: () => ({ mode: "remote-center", rootDir: "/unused" }) }]]),
      binding: async () => {
        throw hostCodedError("execution_scope_mismatch", cause);
      },
      code,
      daemonErrorMessage,
      diagnosticForError,
      rejectHostAction,
    } as unknown as DaemonHostApiContext,
    receipt = await createDaemonHostRepositoryApi(context).run(
      "probe",
      { kind: "task-review-consent", taskId: "task-one", executionId: "execution-one", reviewId: "review-one" },
      { transportKind: "fleet-tls", nodePrincipal: { nodeId: "edge-two", personId: "owner" } },
    );
  t.diagnostic(JSON.stringify(receipt));
  assert.equal(receipt.outcome, "op_rejected");
  assert.equal(receipt.code, "execution_scope_mismatch");
  assert.ok("diagnostic" in receipt);
  assert.equal(receipt.diagnostic?.field, "executionScope");
  assert.match(String(receipt.diagnostic?.actual), /source=node:edge-two/u);
  assert.match(String(receipt.rejectionExplanation), /Only the center writer can confirm this cut/u);
  assert.match(
    String(receipt.rejectionExplanation),
    /ha task review-consent task-one --execution-id execution-one --review-id review-one/u,
  );
});
