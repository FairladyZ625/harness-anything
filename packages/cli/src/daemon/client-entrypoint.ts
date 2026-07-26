import path from "node:path";
import { fileURLToPath } from "node:url";

export function daemonClientCliEntrypointPath(moduleUrl: string | URL = import.meta.url): string {
  const clientUrl = new URL(moduleUrl);
  const extension = path.posix.extname(clientUrl.pathname);
  if (extension !== ".ts" && extension !== ".js") {
    throw new Error(`unsupported daemon client module extension: ${extension || "<none>"}`);
  }
  return fileURLToPath(new URL(`../index${extension}`, clientUrl));
}
