export class DaemonRepoRootResolutionError extends Error {
  readonly rootDir: string;

  constructor(rootDir: string) {
    super(`current root is not registered with the user daemon registry. Run: ha daemon repo register --repo-id <id> --root ${JSON.stringify(rootDir)}`);
    this.name = "DaemonRepoRootResolutionError";
    this.rootDir = rootDir;
  }
}
