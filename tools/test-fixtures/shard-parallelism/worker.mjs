import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const [root, id, peerId, rawExitCode] = process.argv.slice(2);
if (!root || !id || !peerId || rawExitCode === undefined) process.exit(2);

writeFileSync(path.join(root, `started-${id}`), "", { flag: "wx" });
const deadline = Date.now() + 2_000;
while (!existsSync(path.join(root, `started-${peerId}`)) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (!existsSync(path.join(root, `started-${peerId}`))) process.exit(9);

await new Promise((resolve) => setTimeout(resolve, 50));
process.exitCode = Number(rawExitCode);
