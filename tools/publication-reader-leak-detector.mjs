import path from "node:path";
import { after } from "node:test";

const publicationReaderRegistrySymbol = Symbol.for(
  "harness-anything.publication-reader-ownership-registry"
);

export function installPublicationReaderLeakDetector() {
  const snapshots = new Set();
  const registry = {
    register(snapshot) {
      snapshots.add(snapshot);
    }
  };
  globalThis[publicationReaderRegistrySymbol] = registry;

  after(() => {
    const leaks = [...snapshots]
      .flatMap((snapshot) => snapshot())
      .sort((left, right) => left.root.localeCompare(right.root));
    if (leaks.length === 0) return;
    const leaksBySite = Map.groupBy(leaks, (leak) => [
      repositoryRelative(leak.owner.file),
      leak.owner.line ?? 0,
      leak.owner.column ?? 0
    ].join(":"));
    throw new Error([...leaksBySite]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, siteLeaks]) => [
        "PUBLICATION_READER_LEAK",
        `file=${repositoryRelative(siteLeaks[0].owner.file)}`,
        ...(siteLeaks[0].owner.line === undefined ? [] : [`line=${siteLeaks[0].owner.line}`]),
        ...(siteLeaks[0].owner.column === undefined ? [] : [`column=${siteLeaks[0].owner.column}`]),
        `readers=${siteLeaks.length}`,
        ...siteLeaks.map((leak) => `root=${leak.root}`)
      ].join(";"))
      .join("\n"));
  });
}

function repositoryRelative(candidate) {
  if (!candidate || candidate === "unknown") return currentTestFile();
  const absolute = path.resolve(candidate);
  const relative = path.relative(process.cwd(), absolute).split(path.sep).join("/");
  return relative === "" || relative === ".." || relative.startsWith("../")
    ? absolute
    : relative;
}

function currentTestFile() {
  const candidate = process.argv[1];
  if (!candidate) return "unknown";
  const absolute = path.resolve(candidate);
  const relative = path.relative(process.cwd(), absolute).split(path.sep).join("/");
  return relative === "" || relative === ".." || relative.startsWith("../")
    ? absolute
    : relative;
}
