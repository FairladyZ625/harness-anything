import { startDaemon } from "../../src/runtime.ts";
import { openBootstrappedRepoCell } from "../repo-settings.fixture.ts";

const [userRoot, daemonId, deadline] = process.argv.slice(2) as [string, string, string?];
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
const daemon = await startDaemon({
  userRoot,
  daemonId,
  ...(deadline ? { shutdownDeadlineMs: Number(deadline) } : {}),
  attachTimeoutMs: 1,
  openCell: async (input) => {
    await gate;
    return openBootstrappedRepoCell(input);
  },
});
if (!("stop" in daemon)) throw new Error("fixture failed to acquire singleton");
process.on("message", (message) => {
  if (message === "release") release();
  if (message === "stop") void daemon.stop().then(() => process.send!("stopped"));
  if (message === "probe") setImmediate(() => process.send!("probed"));
});
process.send!("ready");
