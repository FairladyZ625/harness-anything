import { consumeKnownError, readDaemonRegistry } from "../../kernel/src/index.ts";
import { yieldToEventLoop } from "./process-port.ts";
import { makeRecoveryProbe } from "./recovery-state.ts";
import { latchReprobeThrottleMs } from "./repo-cell.ts";
import type { DaemonHostRegistryContext } from "./daemon-host-context.ts";

// Host-level latch self-heal, mirroring RepoCell's attemptRecovery cadence: a repo parked in
// `unavailable` is re-opened (openRegistered) when a command touches it, throttled to one probe
// per interval; a fresh latch earns one immediate probe, a failed probe keeps its stamp. Success
// moves the repo into `cells` and out of `unavailable`; failure refreshes the reported cause.
export async function attemptHostRecovery(context: DaemonHostRegistryContext, repoId: string): Promise<void> {
  await context.waitForWarming(repoId);
  if (context.cells.has(repoId) || context.warming.has(repoId) || !context.unavailable.has(repoId)) return;
  const probe = context.unavailableProbes.get(repoId) ?? makeRecoveryProbe(latchReprobeThrottleMs);
  context.unavailableProbes.set(repoId, probe);
  if (!probe.begin(Date.parse(context.now()))) return;
  const repo = readDaemonRegistry({ userRoot: context.input.userRoot }).repos.find(
    (repo) => repo.repoId === repoId && repo.state === "enabled",
  );
  if (!repo) return;
  if (context.pruneMissingRoot(repo)) {
    context.unavailable.delete(repoId);
    context.unavailableProbes.delete(repoId);
    return;
  }
  try {
    await context.openRegistered(repo);
    context.unavailableProbes.delete(repoId);
  } catch (error) {
    consumeKnownError(error);
    context.unavailable.set(repoId, context.unavailableStatus(repoId, repo.canonicalRoot, repo.mode, error));
  }
}

export async function waitForWarming(context: DaemonHostRegistryContext, repoId: string): Promise<void> {
  const settlement = context.warmingSettlements.get(repoId);
  if (!settlement) return;
  void context.startInitialAttachments();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5000);
    void settlement.promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function startInitialAttachments(context: DaemonHostRegistryContext): Promise<void> {
  if (context.initialAttachments) return context.initialAttachments;
  context.initialAttachments = new Promise((resolve) =>
    setImmediate(() => {
      void context.attachInitial().then(resolve);
    }),
  );
  return context.initialAttachments;
}

export async function attachInitial(context: DaemonHostRegistryContext): Promise<void> {
  // Attach one workspace per event-loop turn. RepoCell replay is largely synchronous;
  // yielding between repos keeps transport requests and shutdown signals responsive.
  const startedAt = performance.now();
  let pruned = 0;
  for (const [index, repo] of context.repos.entries()) {
    if (context.closing || context.input.shutdownRequested?.()) break;
    if (!context.warming.has(repo.repoId)) continue; // unregistered or synchronously re-registered after bind
    if (context.pruneMissingRoot(repo)) {
      pruned += 1;
      continue;
    }
    try {
      await context.openRegistered(repo, {
        attachIndex: index + 1,
        attachTotal: context.repos.length,
      });
    } catch (error) {
      consumeKnownError(error);
      context.latchUnavailable(
        repo.repoId,
        context.unavailableStatus(repo.repoId, repo.canonicalRoot, repo.mode, error),
      );
    }
    await yieldToEventLoop();
  }
  context.input.recordLifecycle?.({
    event: "attachments_settled",
    attachTotal: context.repos.length,
    attached: context.repos.filter((repo) => context.cells.has(repo.repoId)).length,
    unavailable: context.repos.filter((repo) => context.unavailable.has(repo.repoId)).length,
    pruned,
    durationMs: performance.now() - startedAt,
  });
}
