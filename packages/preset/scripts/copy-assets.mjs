import { cpSync, rmSync } from "node:fs";

const target = new URL("../dist/assets/", import.meta.url);
rmSync(target, { recursive: true, force: true });
cpSync(new URL("../assets/", import.meta.url), target, { recursive: true });
