// G38 probe for the cloud single-writer shard: one amend through the shard over a real SQLite
// repository whose collection reads (task index, lists, relations, event pages) are presented at
// the measured size. Every projection and store call the write turn makes is counted, and every
// unkeyed collection read is charged the full size, so a shard that walked a collection would grow.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const load = (rootDir, relative) => import(pathToFileURL(path.join(rootDir, relative)).href);
const COLLECTION_METHODS = new Set(["readTaskIndex", "list", "readRelationQuery", "readTaskChildCounts", "readEvents"]);

// A relation query keyed by its source or target entity and child counts for named task ids are
// indexed point reads of the target task's own edges; only an unkeyed collection read is charged.
function unkeyed(property, [query]) {
  if (property === "readTaskChildCounts") return false;
  if (property === "readRelationQuery") return !query?.source && !query?.target;
  return true;
}

function countingFacade(target, counts, key, size) {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") return value;
      return (...args) => {
        counts[key] += 1;
        if (COLLECTION_METHODS.has(property)) counts.collectionRowsExamined += unkeyed(property, args) ? size : 0;
        if (property === "append") counts.appendedEvents += 1;
        return value.apply(object, args);
      };
    },
  });
}

export async function measureCloudWriterLedgerTasks(rootDir, size) {
  const [{ createCloudWriterShard }, storage, { initRepo }, fixture, { removeTempRepository }] = await Promise.all([
    load(rootDir, "packages/daemon/src/writer-cell/cloud-writer-shard.ts"),
    import("@harness-anything/storage"),
    load(rootDir, "packages/daemon/test/migration-import.fixtures.ts"),
    load(rootDir, "packages/daemon/test/fixtures/cloud-writer-shard.fixture.ts"),
    load(rootDir, "tools/fixtures/remove-temp-repository.ts"),
  ]);
  const root = mkdtempSync(path.join(tmpdir(), "ha-g38-cloud-writer-")),
    repository = path.join(root, "repository"),
    counts = { projectionCalls: 0, storeCalls: 0, collectionRowsExamined: 0, appendedEvents: 0 };
  let store, projection;
  try {
    initRepo(repository);
    store = storage.makeTaskEventStore({ repoId: "cloud-cost", rootDir: repository });
    fixture.seedCloudTask(store, repository, "task_cloud_cost", "Cloud cost");
    projection = storage.makeTaskProjection({ rootDir: repository, eventStore: store });
    projection.rebuild();
    const shard = createCloudWriterShard({
      repositories: new Map([
        [
          "cloud-cost",
          {
            store: countingFacade(store, counts, "storeCalls", size),
            projection: countingFacade(projection, counts, "projectionCalls", size),
            withAppendFence: (operation) => operation(),
          },
        ],
      ]),
      authorizer: fixture.allowOwner,
      source: { kind: "node", nodeId: "cloud-cost" },
      maxInFlight: 1,
    });
    const response = await shard.handle(
      fixture.cloudRequest(
        "cloud-cost",
        { kind: "task-amend", taskId: "task_cloud_cost", patches: [{ field: "title", value: "Cloud cost renamed" }] },
        { idempotencyKey: `cost-${size}` },
      ),
    );
    if (response.status !== 200) throw new Error(`cloud writer probe failed: ${await response.text()}`);
    return { size, counts };
  } finally {
    projection?.close();
    await store?.drain();
    removeTempRepository(root);
  }
}
