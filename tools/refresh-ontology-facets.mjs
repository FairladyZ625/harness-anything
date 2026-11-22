import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const families = ["action-source-facets", "source-contract-facets"];
const DEFAULT_DOMAIN = fileURLToPath(new URL("../packages/kernel/src/domain/", import.meta.url));
export const REFRESH_ONTOLOGY_FACETS_REMEDY = "node tools/refresh-ontology-facets.mjs --write";

export function ontologyFacetShardFiles(domain) {
  return families.flatMap((family) =>
    readdirSync(path.join(domain, family), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => `${family}/${entry.name}`)
      .sort(),
  );
}

const byText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const mapByKey = (groups, map) =>
  Object.fromEntries(
    Object.keys(groups)
      .sort()
      .map((key) => [key, map(groups[key])]),
  );

function rowsInKeyOrder(rows, key, sourcePath, shard) {
  for (const row of rows) {
    const file = sourcePath(row);
    const owner = file?.startsWith("tools/") ? "tools" : /^packages\/([^/]+)\//u.exec(file)?.[1];
    if (owner !== shard) throw new Error(`${key(row)} belongs in ${owner ?? "a known package"}, found in ${shard}`);
  }
  return rows.toSorted((left, right) => byText(key(left), key(right)));
}

export function formatOntologyFacetShard(file, content) {
  const [family, name] = file.split("/");
  const shard = path.basename(name, ".json");
  const data = JSON.parse(content);
  let sorted;
  if (family === "action-source-facets") {
    const { actions, sources } = data;
    sorted = {
      ...(shard === "kernel" ? { actions: mapByKey(actions, (row) => row) } : {}),
      sources: mapByKey(sources, (rows) =>
        rowsInKeyOrder(
          rows,
          (row) => row.candidateId,
          (row) => row.candidateId.split(":")[2]?.split("#")[0],
          shard,
        ),
      ),
    };
  } else {
    sorted = mapByKey(data, ({ contracts, judgments }) => {
      const sort = (rows) =>
        rowsInKeyOrder(
          rows,
          (row) => row.id,
          (row) => row.symbol.split("#")[0],
          shard,
        );
      return { contracts: sort(contracts), judgments: sort(judgments) };
    });
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export function checkOntologyFacetShards(domain = DEFAULT_DOMAIN) {
  const files = ontologyFacetShardFiles(domain);
  if (files.length === 0) throw new Error(`No ontology facet shards found under ${domain}`);
  const drifted = [];
  for (const file of files) {
    const text = readFileSync(path.join(domain, file), "utf8").replaceAll("\r\n", "\n");
    const expected = formatOntologyFacetShard(file, text);
    if (expected !== text) drifted.push(file);
  }
  return { ok: drifted.length === 0, checked: files.length, drifted };
}

export function writeOntologyFacetShards(domain = DEFAULT_DOMAIN) {
  const files = ontologyFacetShardFiles(domain);
  if (files.length === 0) throw new Error(`No ontology facet shards found under ${domain}`);
  const updated = [];
  for (const file of files) {
    const fullPath = path.join(domain, file);
    const raw = readFileSync(fullPath, "utf8");
    const expected = formatOntologyFacetShard(file, raw.replaceAll("\r\n", "\n"));
    if (raw !== expected) {
      writeFileSync(fullPath, expected, "utf8");
      updated.push(file);
    }
  }
  return { checked: files.length, updated };
}

function parseCliArgs(argv) {
  let domain = DEFAULT_DOMAIN;
  const positional = [];
  let mode = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check" || arg === "--write") {
      if (mode !== null && mode !== arg)
        throw new Error(
          "usage: node tools/refresh-ontology-facets.mjs --check | --write | <facet-directory>/<package>.json",
        );
      mode = arg;
      continue;
    }
    if (arg === "--domain") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--domain requires a directory path");
      domain = path.resolve(value);
      index += 1;
      continue;
    }
    positional.push(arg);
  }
  return { mode, domain, positional };
}

// Supports --check (fast static gate), --write (in-place canonicalization of all shards),
// or printing one shard to stdout for review.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { mode, domain, positional } = parseCliArgs(process.argv.slice(2));
  if (mode === "--check") {
    if (positional.length > 0)
      throw new Error("usage: node tools/refresh-ontology-facets.mjs --check [--domain <dir>]");
    const result = checkOntologyFacetShards(domain);
    if (!result.ok) {
      console.error(
        `Ontology facet shards are not canonically formatted (${result.drifted.length}/${result.checked} drifted):`,
      );
      for (const file of result.drifted) console.error(`- ${file}`);
      console.error(`Run \`${REFRESH_ONTOLOGY_FACETS_REMEDY}\` to normalize ontology facet shards.`);
      process.exitCode = 1;
    } else {
      console.log(`Ontology facet shards check passed (${result.checked} shard(s)).`);
    }
  } else if (mode === "--write") {
    if (positional.length > 0)
      throw new Error("usage: node tools/refresh-ontology-facets.mjs --write [--domain <dir>]");
    const result = writeOntologyFacetShards(domain);
    console.log(
      result.updated.length > 0
        ? `Normalized ${result.updated.length}/${result.checked} ontology facet shard(s): ${result.updated.join(", ")}`
        : `Ontology facet shards already canonical (${result.checked} shard(s)).`,
    );
  } else {
    const [file, ...extra] = positional;
    if (extra.length || !ontologyFacetShardFiles(domain).includes(file))
      throw new Error(
        "usage: node tools/refresh-ontology-facets.mjs --check | --write | <facet-directory>/<package>.json",
      );
    console.log(formatOntologyFacetShard(file, readFileSync(path.join(domain, file), "utf8")).trimEnd());
  }
}
