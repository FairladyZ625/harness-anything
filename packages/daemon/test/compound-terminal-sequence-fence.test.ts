// harness-test-tier: contract
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCompoundReceiptServiceV2 } from "@harness-anything/application";
import { createDurableCompoundReceiptStoreV2 } from "../src/index.ts";

test("two processes publishing the same terminal sequence cannot overwrite each other", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-terminal-sequence-race-"));
  const children: ChildProcess[] = [];
  try {
    const receiptDirectory = path.join(root, "receipts");
    const setupStore = createDurableCompoundReceiptStoreV2({ directory: receiptDirectory });
    const setupService = createCompoundReceiptServiceV2({
      store: setupStore,
      createWaiterId: () => "waiter-terminal-sequence",
      createResultToken: () => Buffer.alloc(32, 0x62).toString("base64url")
    });
    const opened = await setupService.openWaiter({
      workspaceId: "workspace-terminal-sequence",
      viewId: "view-terminal-sequence",
      opId: "op-terminal-sequence"
    });
    const initial = await setupStore.get(opened.identity);
    assert.ok(initial);
    const args = [receiptDirectory, encodedIdentity(opened.identity)];
    const first = startRacer(children, ["first", ...args]);
    const second = startRacer(children, ["second", ...args]);
    assert.deepEqual(await Promise.all([nextChildMessage(first), nextChildMessage(second)]), [
      { type: "ready", contenderId: "first" },
      { type: "ready", contenderId: "second" }
    ]);

    first.send("release");
    second.send("release");
    const outcomes = await Promise.all([nextChildMessage(first), nextChildMessage(second)]);
    const committed = outcomes.filter((outcome) => outcome.type === "committed");
    assert.equal(committed.length, 1);
    assert.deepEqual(outcomes.filter((outcome) => outcome.type === "error").map((outcome) => outcome.code), [
      "COMPOUND_TERMINAL_SEQUENCE_CONFLICT"
    ]);
    assert.deepEqual(readdirSync(receiptDirectory).filter((name) =>
      name.startsWith("compound-receipt-terminal-state-v2.")), [
      "compound-receipt-terminal-state-v2.1.json"
    ]);
    const recovered = await createDurableCompoundReceiptStoreV2({ directory: receiptDirectory }).get(opened.identity);
    assert.deepEqual(recovered, committed[0]!.receipt);
    assert.equal(recovered?.delivery, "DETACHED");
    assert.equal(recovered?.terminalLSN, 1);
    assert.equal(recovered?.sequence, initial.sequence + 1);
  } finally {
    for (const child of children) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

function startRacer(children: ChildProcess[], args: ReadonlyArray<string>): ChildProcess {
  const child = fork(fileURLToPath(new URL("./fixtures/compound-terminal-sequence-racer.ts", import.meta.url)), [...args], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    execArgv: process.execArgv.filter((argument) => argument !== "--test-force-exit")
  });
  children.push(child);
  return child;
}

function nextChildMessage(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      cleanup();
      resolve(message as Record<string, unknown>);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`terminal sequence racer exited before response: code=${code};signal=${signal}`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.once("message", onMessage);
    child.once("exit", onExit);
  });
}

function encodedIdentity(identity: unknown): string {
  return Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
}
