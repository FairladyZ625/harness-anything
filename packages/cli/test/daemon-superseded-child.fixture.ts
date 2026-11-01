import { startDaemon } from "@harness-anything/daemon/internal/runtime";

const [userRoot, runtimeFile, endpoint] = process.argv.slice(2) as [string, string, string];
const daemon = await startDaemon({
  daemonId: "default",
  userRoot,
  runtimeFile,
  endpoint,
  onSupersededExit: () => process.disconnect(),
});
if (!("stop" in daemon)) throw new Error("fixture failed to acquire singleton");
process.send!("ready");
