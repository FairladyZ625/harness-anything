import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const families = ["action-source-facets", "source-contract-facets"];

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

// Print one shard for review or redirection to a temporary file. Moves are made
// explicitly in the two affected shards, leaving other packages out of the diff.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const domain = new URL("../packages/kernel/src/domain/", import.meta.url);
  const [file, ...extra] = process.argv.slice(2);
  if (extra.length || !ontologyFacetShardFiles(fileURLToPath(domain)).includes(file))
    throw new Error("usage: node tools/refresh-ontology-facets.mjs <facet-directory>/<package>.json");
  console.log(formatOntologyFacetShard(file, readFileSync(new URL(file, domain), "utf8")).trimEnd());
}
