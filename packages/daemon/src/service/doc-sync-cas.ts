import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DirtyEntry } from "@harness-anything/application/doc-sync";

export function isStandaloneCasObject(authoredRoot: string, entry: DirtyEntry): boolean {
  if (entry.status !== "added") return false;
  const match = /^objects\/sha256\/([0-9a-f]{2})\/([0-9a-f]{62})$/u.exec(entry.path);
  if (!match) return false;
  const absolutePath = path.join(authoredRoot, entry.path);
  if (!existsSync(absolutePath)) return false;
  const actual = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  return actual === `${match[1]}${match[2]}`;
}
