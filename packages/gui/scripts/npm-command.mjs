import { execFileSync } from "node:child_process";

// npm supplies its JS entry to lifecycle scripts. Executing it through Node
// also works on Windows, where directly spawning npm.cmd fails with EINVAL.
export function runNpm(args, options) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Desktop runtime preparation must run through npm run package:prepare.");
  return execFileSync(process.execPath, [npmCli, ...args], options);
}
