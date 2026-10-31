// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cmdShellInvocation } from "@harness-anything/storage";

import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

// The only environment that can adjudicate cmd.exe's two parsing layers (cmd /c plus the
// batch %* re-parse inside an npm-style shim) is real Windows; the encoder's contract is
// pinned cross-platform in kernel/test/store/cmd-command-line.test.ts.
const windowsOnly =
  process.platform === "win32" ? false : "requires cmd.exe batch argument semantics through a .cmd shim";

test(
  "a hostile prompt rides through a .cmd shim verbatim without executing commands",
  { skip: windowsOnly },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-windows-cmd-"));
    try {
      const received = path.join(parent, "argv.json"),
        marker = path.join(parent, "injected.txt"),
        shim = writeProviderExecutable(
          path.join(parent, "hostile-stub.mjs"),
          `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.STUB_ARGV, JSON.stringify(process.argv.slice(2)));\n`,
        ),
        // If cmd ever executed part of this argument, `echo` would create the marker file.
        hostile = `say " & echo pwned > ${marker} & " and %PATH% and ^`,
        invocation = cmdShellInvocation(shim, ["--prompt", hostile], process.env);
      assert.equal(invocation.windowsVerbatimArguments, true);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, {
          cwd: parent,
          env: { ...process.env, STUB_ARGV: received },
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: true,
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => process.stderr.write(chunk));
        child.once("error", reject);
        child.once("close", () => resolve());
      });
      const argv = JSON.parse(readFileSync(received, "utf8")) as string[];
      assert.deepEqual(argv, ["--prompt", hostile]);
      assert.equal(existsSync(marker), false, "no part of the prompt may execute as a cmd command");
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);
