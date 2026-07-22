import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  calculateDaemonArtifactIdentity,
  daemonBuildProvenanceFilename
} from "../../../daemon/src/protocol/daemon-artifact-identity.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../../..");
const packageRoot = path.join(repositoryRoot, "packages", "cli");
const distEntrypoint = path.join(packageRoot, "dist/cli/src/index.js");
const sourceEntrypoint = path.join(packageRoot, "src/index.ts");
const artifact = calculateDaemonArtifactIdentity(distEntrypoint);
const source = calculateDaemonArtifactIdentity(sourceEntrypoint);
const git = (...args: ReadonlyArray<string>): string => execFileSync("git", [...args], {
  cwd: repositoryRoot,
  encoding: "utf8",
  windowsHide: true
}).trim();
const document = {
  schema: "daemon-build-provenance/v1",
  sourceRoot: repositoryRoot,
  sourceCommit: git("rev-parse", "HEAD"),
  sourceDirty: git("status", "--porcelain").length > 0,
  sourceFingerprint: source.identity,
  contentFingerprint: artifact.identity,
  artifactFileCount: artifact.fileCount,
  builtAt: new Date().toISOString()
};

writeFileSync(
  path.join(artifact.artifactRoot, daemonBuildProvenanceFilename),
  `${JSON.stringify(document, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 }
);
