#!/usr/bin/env node
/**
 * Cross-generation decision machineDigest pairing (verification step 5e).
 *
 * For every decision.md present in BOTH generations, reconstructs the kernel
 * decision-machine-content/v1 semantic from each document's frontmatter,
 * normalizes the OLD generation's semantic through the approved word map
 * (relations retired -> edge_retired is the only semantic-visible rename),
 * and requires kernel decisionMachineDigest equality with the NEW generation.
 *
 * Any decision present in only one generation, or any digest mismatch, is a
 * failure. Exit 0 == every decision paired and equal.
 *
 * Usage:
 *   node scripts/rename-drill/decision-digest-pair.mjs \
 *     --old-repo <old-harness-git> --new-repo <new-harness-git> \
 *     [--old-ref refs/ha/canonical] [--new-ref refs/ha/canonical]
 */
import { git, streamTreeBlobs } from "./ledger-walk.mjs";
import { decisionSemanticFromDocument } from "./decision-semantics.mjs";
import { decisionMachineDigest } from "../../packages/kernel/src/domain/fact-event.ts";

const args = parseArgs(process.argv.slice(2));
if (!args["old-repo"] || !args["new-repo"]) { console.error("usage: decision-digest-pair.mjs --old-repo <repo> --new-repo <repo> [--old-ref <ref>] [--new-ref <ref>]"); process.exit(2); }
const OLD_REF = args["old-ref"] ?? "refs/ha/canonical", NEW_REF = args["new-ref"] ?? "refs/ha/canonical";

async function readDecisionDigests(repo, ref, normalize) {
  const digests = new Map();
  let movedByRename = 0;
  for await (const { path, body } of streamTreeBlobs(repo, ref, "decisions")) {
    if (!/^decisions\/decision-[^/]+\/decision\.md$/u.test(path)) continue;
    const semantic = decisionSemanticFromDocument(body, `${repo}:${path}`);
    const digest = decisionMachineDigest(normalize ? normalizeSemantic(semantic) : semantic);
    if (normalize && digest !== decisionMachineDigest(semantic)) movedByRename += 1;
    digests.set(path, digest);
  }
  return { digests, movedByRename };
}

/** Word-map normalization of the only semantic-visible renamed field. */
function normalizeSemantic(semantic) {
  return { ...semantic, relations: semantic.relations.map((relation) => relation !== null && typeof relation === "object" && relation.state === "retired" ? { ...relation, state: "edge_retired" } : relation) };
}

const oldCut = (await git(args["old-repo"], ["rev-parse", OLD_REF])).trim();
const newCut = (await git(args["new-repo"], ["rev-parse", NEW_REF])).trim();
const { digests: oldDigests, movedByRename } = await readDecisionDigests(args["old-repo"], OLD_REF, true);
const { digests: newDigests } = await readDecisionDigests(args["new-repo"], NEW_REF, false);

const failures = [];
let equal = 0;
for (const [path, oldDigest] of oldDigests) {
  const newDigest = newDigests.get(path);
  if (newDigest === undefined) { failures.push(`${path}: present only in the old generation`); continue; }
  if (oldDigest !== newDigest) { failures.push(`${path}: normalized old digest ${oldDigest} != new digest ${newDigest}`); continue; }
  equal += 1;
}
for (const path of newDigests.keys()) if (!oldDigests.has(path)) failures.push(`${path}: present only in the new generation`);

if (failures.length > 0) { console.error(`PAIRING FAILED (${failures.length}):\n${failures.slice(0, 40).join("\n")}`); process.exit(1); }
console.log(JSON.stringify({ oldCut, newCut, decisionsPaired: equal, digestsMovedByRename: movedByRename, failures: 0 }));

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? "");
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (index + 1 < argv.length && !String(argv[index + 1]).startsWith("--")) { out[key] = argv[index + 1]; index += 1; }
    else out[key] = true;
  }
  return out;
}
