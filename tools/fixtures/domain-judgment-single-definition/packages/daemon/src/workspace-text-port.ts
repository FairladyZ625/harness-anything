import { readFileSync } from "node:fs";
import path from "node:path";

export function readWorkspaceText(rootDir: string, requested: string, _field: string): string {
  return readFileSync(path.resolve(rootDir, requested), "utf8");
}
