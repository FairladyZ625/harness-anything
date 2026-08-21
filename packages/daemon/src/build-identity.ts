import path from "node:path";
import { fileURLToPath } from "node:url";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { runProcessText } from "./process-port.ts";

export interface DaemonBuildStamp { readonly commit: string | null }
let stamp: DaemonBuildStamp | undefined;
// A resident daemon serves the code it was started from for its whole life, while the tree it came
// from keeps moving, so the daemon is the side that has to say which build it is: a commit frozen
// here at first use. Packaged runs carry a build stamp; a source-tree run resolves it from git.
// Clients run the same function against their own tree, and a mismatch is the diagnosis, not an
// error to paper over — this repo keeps no cross-version compatibility.
export function daemonBuildStamp(): DaemonBuildStamp {
  stamp ??= resolveStamp();
  return stamp;
}
function resolveStamp(): DaemonBuildStamp {
  const stamped = process.env.HARNESS_BUILD_COMMIT?.trim();
  if (stamped) return { commit: stamped };
  try {
    const commit = runProcessText("git", ["rev-parse", "HEAD"], path.dirname(fileURLToPath(import.meta.url))).trim();
    return { commit: commit || null };
  } catch (error) { consumeKnownError(error); return { commit: null }; }
}
