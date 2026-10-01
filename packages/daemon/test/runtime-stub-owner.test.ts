// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// A dispatched stub runs under a detached worker host that no daemon stop reaches, so a stub
// that holds is only ever ended by its own test. When that test dies first, the stub has to go
// on its own.
test("a holding provider stub exits once the test process that wrote it is gone", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-stub-owner-")),
    target = path.join(root, "provider"),
    stubModule = new URL("./fixtures/runtime-stub.ts", import.meta.url).href;
  try {
    const writer = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { writeProviderExecutable } from ${JSON.stringify(stubModule)}; writeProviderExecutable(${JSON.stringify(target)}, "setInterval(() => {}, 1000);\\n");`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(writer.status, 0, writer.stderr);
    const stub = spawn(process.execPath, [target], { stdio: "ignore" }),
      exited = once(stub, "exit");
    let timer: NodeJS.Timeout | undefined;
    try {
      const [code] = await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("the stub outlived the process that wrote it")), 10_000);
        }),
      ]);
      assert.equal(code, 0);
    } finally {
      clearTimeout(timer);
      stub.kill("SIGKILL");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
