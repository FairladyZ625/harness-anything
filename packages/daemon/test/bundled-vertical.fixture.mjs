import { readFileSync } from "node:fs";
import path from "node:path";
import { defaultAssets } from "@harness-anything/preset/internal/preset-resolver-common";
import { compileVerticalContract } from "@harness-anything/kernel";
import { decodeVerticalDefinition } from "@harness-anything/kernel/schemas";

/** Register the bundled runtime Artifact scopes before deriving test Base policy groups. */
export function registerBundledVertical() {
  compileVerticalContract(
    decodeVerticalDefinition(JSON.parse(readFileSync(path.join(defaultAssets, "vertical.json"), "utf8"))),
  );
}
