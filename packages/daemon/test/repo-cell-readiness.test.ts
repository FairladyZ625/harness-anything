// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createRepoCellApi, type RepoCellApiContext } from "../src/repo-cell-api.ts";

type Cut = { readonly status: "ready" | "pending"; readonly watermark: number; readonly sourceRevision: number };

function readinessContext(
  cut: Cut,
  counters: { list: number; readCut: number },
  state = "attached",
): RepoCellApiContext {
  return {
    extracted: {},
    mode: "local",
    fleetRoster: null,
    input: { repoId: "repository" },
    state,
    causeClass: null,
    latched: () => "latched",
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    projection: {
      readCut: () => {
        counters.readCut += 1;
        return cut;
      },
      list: () => {
        counters.list += 1;
        return { ...cut, rows: [], warnings: [] };
      },
    },
  } as unknown as RepoCellApiContext;
}

test("verifyReadiness probes the projection cut without materializing task rows", async () => {
  const counters = { list: 0, readCut: 0 },
    cell = createRepoCellApi(readinessContext({ status: "ready", watermark: 7, sourceRevision: 7 }, counters));

  assert.deepEqual(await cell.verifyReadiness(), { cellState: "attached", l2State: "ready" });
  assert.equal(counters.readCut, 1);
  assert.equal(counters.list, 0, "a readiness verdict must not read the task snapshot list");
});

test("verifyReadiness fails closed on a pending cut and a latched cell", async () => {
  const pending = { list: 0, readCut: 0 };
  await assert.rejects(
    createRepoCellApi(
      readinessContext({ status: "pending", watermark: 6, sourceRevision: 7 }, pending),
    ).verifyReadiness(),
    (error: Error & { code?: string }) =>
      error.code === "repo_unavailable" && /L2 projection is not ready/u.test(error.message),
  );
  assert.equal(pending.list, 0);

  const latched = { list: 0, readCut: 0 };
  await assert.rejects(
    createRepoCellApi(
      readinessContext({ status: "ready", watermark: 7, sourceRevision: 7 }, latched, "unavailable"),
    ).verifyReadiness(),
    /latched/u,
  );
  assert.equal(latched.readCut, 0);
});
