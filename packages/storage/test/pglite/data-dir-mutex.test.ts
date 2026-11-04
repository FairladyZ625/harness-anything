// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { fork } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePGliteDirectoryMutex } from "../../src/pglite/data-dir-mutex.ts";
import { withTempStoreAsync } from "../store/helpers.ts";

test(
  "kernel mutex rejects concurrent owners and releases on process or thread death",
  { timeout: 30_000 },
  async () => {
    await withTempStoreAsync(async (rootDir) => {
      for (const kind of ["process", "thread"]) {
        const directory = join(rootDir, kind),
          url = new URL("./directory-mutex-child.fixture.ts", import.meta.url),
          child =
            kind === "process"
              ? fork(fileURLToPath(url), [directory], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] })
              : new Worker(url, { workerData: { directory } }),
          exited = once(child, "exit");
        try {
          const [message] = await once(child, "message");
          assert.equal(message.held, true);
          assert.throws(() => acquirePGliteDirectoryMutex(directory), { code: "ERR_SQLITE_ERROR", errcode: 5 });
        } finally {
          if (child instanceof Worker) await child.terminate();
          else child.kill("SIGKILL");
          await exited;
        }
        const reopened = acquirePGliteDirectoryMutex(directory);
        reopened.close();
      }
    });
  },
);
