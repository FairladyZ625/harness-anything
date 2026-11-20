import { hash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { mergeAuthorizationProofs } from "./authorization-audit-shards.mjs";
import { git } from "./git.mjs";

export const AUTHORIZATION_CI_SHARD_COUNT = 4;
const schema = "authorization-proof-shard/v1";
const fileName = (index) => `authorization-shard-${index}.json`;

export function authorizationCiRun(rootDir, changedFiles, env = process.env) {
  const { AUTHORIZATION_CI_MODE: mode, AUTHORIZATION_CI_DIR: dir, AUTHORIZATION_CI_DATE: today } = env;
  if (mode === undefined) return null;
  if (mode === "blocked") throw new Error("a required quick-gate job failed, was cancelled, or did not run");
  if (
    (mode !== "shard" && mode !== "collect") ||
    !dir ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(today) ||
    Number.isNaN(Date.parse(today)) ||
    today !== new Date(today).toISOString().slice(0, 10)
  )
    throw new Error("authorization CI requires a proof directory and the workflow's UTC audit date");
  const revision = git(rootDir, ["rev-parse", "HEAD"]).trim();
  if (revision !== env.GITHUB_SHA) throw new Error("authorization CI checkout does not match GITHUB_SHA");
  const count = AUTHORIZATION_CI_SHARD_COUNT;
  const stamp = { revision, today, scope: hash("sha256", JSON.stringify(changedFiles ?? null)), count };
  if (mode === "collect") return { mode, dir, stamp };
  const index = Number(env.AUTHORIZATION_CI_SHARD);
  if (String(index) !== env.AUTHORIZATION_CI_SHARD || !Number.isInteger(index) || index < 0 || index >= count)
    throw new Error(`authorization CI requires a shard index within 0..${count - 1}`);
  return { mode, dir, stamp, partition: { index, count } };
}

export function serializeAuthorizationShard({ stamp, partition: { index } }, proof) {
  return JSON.stringify({ schema, stamp, index, ...proof });
}

export function readAuthorizationShards({ dir, stamp }, inventory) {
  const files = Array.from({ length: stamp.count }, (_, index) => fileName(index));
  const actualFiles = readdirSync(dir).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify([...files].sort()))
    throw new Error(
      `authorization CI needs every shard exactly once (expected ${files.join(", ")}; found ${actualFiles.join(", ")})`,
    );
  const parts = files.map((file, index) => {
    const part = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    if (
      part?.schema !== schema ||
      part.index !== index ||
      JSON.stringify(part.stamp) !== JSON.stringify(stamp) ||
      !Array.isArray(part.rows) ||
      !Array.isArray(part.sourceProofs)
    )
      throw new Error(`authorization shard ${index} has invalid proof data or incompatible audit inputs`);
    return part;
  });
  const proof = mergeAuthorizationProofs(parts);
  const routes = proof.rows.map(({ index, id }) => [index, id]);
  const sources = proof.sourceProofs.map(({ ordinal, row }) => [ordinal, row.id, row.kind, row.route]);
  for (const [key, actual] of Object.entries({ routes, sources })) {
    if (JSON.stringify(actual) !== JSON.stringify(inventory[key]))
      throw new Error(
        `authorization shard coverage differs for ${key} (expected ${inventory[key].length}; found ${actual.length})`,
      );
  }
  return proof;
}
