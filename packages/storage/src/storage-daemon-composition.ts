import {
  canonicalDaemonRegistryRoot,
  writeDaemonRegistryRepo,
  type DaemonRegistryRegisterInput,
} from "@harness-anything/kernel/daemon-registry";
import { resolveLedgerGitLayout } from "./store/ledger-git-layout.ts";
import {
  configureLedgerMaintenance,
  installLedgerCommitGuard,
  makeLocalVersionControlSystem,
} from "./store/local-version-control-system.ts";

export function registerDaemonRepo(input: DaemonRegistryRegisterInput) {
  if (!input.canonicalRoot || input.mode === "remote-proxy") return writeDaemonRegistryRepo(input);
  const canonicalRoot = canonicalDaemonRegistryRoot(input.canonicalRoot);
  const ledger = resolveLedgerGitLayout(canonicalRoot);
  const vcs = makeLocalVersionControlSystem();
  configureLedgerMaintenance(ledger.rootDir);
  installLedgerCommitGuard(ledger.authoredRoot);
  const branch = vcs.originHeadBranch(ledger.rootDir) ?? vcs.currentBranch(ledger.rootDir);
  if (!branch) throw new Error(`canonicalRoot must have an attached default Git branch: ${ledger.rootDir}`);
  return writeDaemonRegistryRepo({ ...input, canonicalRoot, authoredBranch: branch });
}
