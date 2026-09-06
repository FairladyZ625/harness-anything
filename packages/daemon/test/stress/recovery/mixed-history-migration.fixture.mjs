import fs from "node:fs";
import { convertLegacyGeneration } from "../../../../kernel/src/index.ts";

const [rootDir, snapshotPath, databasePath] = process.argv.slice(2);
if (!rootDir || !snapshotPath || !databasePath)
  throw new Error("usage: mixed-history-migration.fixture.mjs <root> <snapshot> <database>");

convertLegacyGeneration({
  rootDir,
  snapshotPath,
  databasePath,
  beforeEvent: (revision) => {
    if (revision !== 2) return;
    fs.writeSync(1, "conversion-killpoint:before_event_2\n");
    process.kill(process.pid, "SIGKILL");
  },
});
throw new Error("conversion did not reach killpoint before_event_2");
