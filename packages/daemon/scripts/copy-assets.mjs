import { spawnSync } from "node:child_process";
import { cpSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = new URL("../dist/", import.meta.url);
rmSync(new URL("preset/assets/", dist), { recursive: true, force: true });
cpSync(new URL("../../preset/assets/", import.meta.url), new URL("preset/assets/", dist), { recursive: true });
// Keep the marker stable for repeated builds of one commit; a daemon should drain only when the
// loaded source identity changes. Archive trees (clean-build gate, source tarballs) have no .git
// to resolve; they share one stable marker so a build without commit identity still never looks
// like a fresh build.
const repository = fileURLToPath(new URL("../../", import.meta.url)),
  commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }),
  buildCommit = process.env.HARNESS_BUILD_COMMIT?.trim() || commit.stdout.trim() || "source-archive";
writeFileSync(new URL("build-id.txt", dist), `${buildCommit}\n`);
const entry = new URL("index.js", dist);
writeFileSync(entry, '#!/usr/bin/env node\nimport "./daemon/src/bin.js";\n');
chmodSync(fileURLToPath(entry), 0o755);
