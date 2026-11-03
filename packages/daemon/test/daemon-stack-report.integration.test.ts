// harness-test-tier: integration
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
for (const mode of ["javascript", "native"]) {
  test(
    `report-on-signal interruption experiment: ${mode}`,
    {
      timeout: 15_000,
      skip: process.platform === "win32" ? "requires POSIX SIGUSR2 diagnostic report signal" : false,
    },
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "ha-report-")),
        child = fork(new URL("./daemon-stack-report.fixture.mjs", import.meta.url), [], {
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          execArgv: [
            "--report-on-signal",
            "--report-exclude-env",
            "--report-exclude-network",
            `--report-directory=${root}`,
          ],
        });
      let reportWritten!: () => void,
        reportOutput = "";
      const reportComplete = new Promise<void>((resolve) => {
        reportWritten = resolve;
      });
      child.stderr!.on("data", (chunk) => {
        reportOutput += chunk.toString();
        if (reportOutput.includes("Node.js report completed")) reportWritten();
      });
      try {
        await once(child, "message");
        const blocked = once(child, "message");
        child.send(mode);
        const [start] = await blocked;
        const recovered = once(child, "message");
        child.kill("SIGUSR2");
        const [end] = await recovered;
        await reportComplete;
        const files = readdirSync(root);
        assert.equal(files.length, 1);
        const report = JSON.parse(readFileSync(path.join(root, files[0]!), "utf8"));
        console.log(
          "report interruption experiment",
          JSON.stringify({
            mode,
            node: process.version,
            blockingAt: start.blockingAt,
            recoveredAt: end.recoveredAt,
            reportAt: Number(report.header.dumpEventTimeStamp),
            capturedDuringBlock: Number(report.header.dumpEventTimeStamp) < end.recoveredAt,
            javascriptStack: report.javascriptStack,
          }),
        );
      } finally {
        if (child.connected) {
          const exit = once(child, "exit");
          child.send("close");
          await exit;
        }
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    },
  );
}
