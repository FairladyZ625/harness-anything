import { rmSync } from "node:fs";
import path from "node:path";

rmSync(path.resolve(import.meta.dirname, "../dist/daemon-build-provenance.json"), { force: true });
