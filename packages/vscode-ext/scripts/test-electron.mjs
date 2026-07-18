import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = mkdtempSync(path.join(tmpdir(), "ha-vsc-"));
const cachePath = path.join(tmpdir(), "ha-vscode-test-cache");
try {
  await runTests({
    version: "1.125.0",
    cachePath,
    extensionDevelopmentPath: packageRoot,
    extensionTestsPath: path.join(packageRoot, "dist/test/suite/index.cjs"),
    launchArgs: [
      `--user-data-dir=${path.join(runtimeRoot, "u")}`,
      `--extensions-dir=${path.join(runtimeRoot, "e")}`,
      "--disable-extensions",
      "--skip-welcome",
      "--skip-release-notes"
    ]
  });
} finally {
  rmSync(runtimeRoot, { recursive: true, force: true });
}
