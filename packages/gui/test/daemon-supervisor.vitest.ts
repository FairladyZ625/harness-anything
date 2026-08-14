// harness-test-tier: contract
import { describe, expect, it } from "vitest";
import { createDaemonSupervisor } from "../src/main/daemon-supervisor.ts";

describe("Electron main daemon supervisor", () => {
  it("owns restart operation identity through terminal settlement", async () => {
    const supervisor = createDaemonSupervisor({ now: (() => { let tick = 0; return () => `2026-08-14T00:00:0${tick++}.000Z`; })(), authorize: async () => ({ ok: false, error: { code: "supervisor_required" } }), restart: async () => ({ before: { daemonId: "d", pid: 10, startedAt: "old" }, after: { daemonId: "d", pid: 11, startedAt: "new" } }) });
    const pending = await supervisor.request({ kind: "restart", authorityRepoId: "repo-a" });
    expect(pending).toMatchObject({ ok: true, outcome: "pending", phase: "queued" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(supervisor.receipt(pending.operationId as string)).toMatchObject({ phase: "settled", before: { pid: 10 }, after: { pid: 11 } });
  });
});
