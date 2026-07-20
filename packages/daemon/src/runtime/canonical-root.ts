// @slice-activation PLT-Boundary W2 exports daemon-owned canonical root identity to host consumers.
import { realpathSync } from "node:fs";
import path from "node:path";

export function canonicalRootIdentity(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}
