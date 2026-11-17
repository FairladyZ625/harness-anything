import { execFileSync } from "node:child_process";
import path from "node:path";
import { HARNESS_LEDGER_WRITER_ENV } from "@harness-anything/storage";

export const cli = path.resolve("packages/cli/src/index.ts");
export const builtCli = path.resolve("packages/cli/dist/cli/src/index.js");

// The ledger repository is created by `ha init`, which supplies the commit
// identity per command instead of configuring it in the repository. Fixture
// commits must carry their own identity: an ambient global identity exists on
// developer machines and not on CI runners.
function gitSpawn(root, args, extraEnv) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "W3 Test",
      GIT_AUTHOR_EMAIL: "w3@example.test",
      GIT_COMMITTER_NAME: "W3 Test",
      GIT_COMMITTER_EMAIL: "w3@example.test",
      ...extraEnv,
    },
  }).trim();
}
export function git(root, ...args) {
  return gitSpawn(root, args, {});
}
// A fixture commit inside the ledger repository plays the out-of-band writer
// whose commit the guard exists to refuse; carrying the daemon's writer marker
// casts the fixture in that role so the state it constructs still lands.
export function gitLedgerWriter(root, ...args) {
  return gitSpawn(root, args, { [HARNESS_LEDGER_WRITER_ENV]: "1" });
}
