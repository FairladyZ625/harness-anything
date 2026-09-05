import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const [source, userRoot, arm] = process.argv.slice(2);
if (!source || !userRoot || !["read", "kill-before-rename", "kill-after-rename"].includes(arm))
  throw new Error("usage: registry-upgrade-process.fixture.mjs <source> <user-root> <arm>");

if (arm !== "read") {
  const originalRename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (String(to).endsWith("registry.json")) {
      fs.writeSync(1, `${arm}\n`);
      if (arm === "kill-before-rename") process.kill(process.pid, "SIGKILL");
      const result = originalRename.call(fs, from, to);
      process.kill(process.pid, "SIGKILL");
      return result;
    }
    return originalRename.call(fs, from, to);
  };
  syncBuiltinESMExports();
}

const { readDaemonRegistry } = await import(pathToFileURL(source).href),
  registry = readDaemonRegistry({ userRoot });
fs.writeSync(
  1,
  `${JSON.stringify({ schema: registry.schema, repoIds: registry.repos.map(({ repoId }) => repoId) })}\n`,
);
