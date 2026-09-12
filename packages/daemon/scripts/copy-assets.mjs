import { randomUUID } from "node:crypto";
import { cpSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = new URL("../dist/", import.meta.url);
rmSync(new URL("preset/assets/", dist), { recursive: true, force: true });
cpSync(new URL("../../preset/assets/", import.meta.url), new URL("preset/assets/", dist), { recursive: true });
writeFileSync(new URL("build-id.txt", dist), `${randomUUID()}\n`);
const entry = new URL("index.js", dist);
writeFileSync(entry, '#!/usr/bin/env node\nimport "./daemon/src/bin.js";\n');
chmodSync(fileURLToPath(entry), 0o755);
