import { FolderSimple, LockKey, WarningCircle } from "@phosphor-icons/react";
import type { SystemRepoRow } from "../api-client.ts";

export function HomeView({
  repos,
  currentRepoId,
  onOpenProject,
}: {
  readonly repos: ReadonlyArray<SystemRepoRow>;
  readonly currentRepoId: string | null;
  readonly onOpenProject: (repoId: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h1 className="ui-title font-semibold">项目</h1>
          <span className="font-mono text-[11px] text-text-faint">{repos.length}</span>
        </div>
        <p className="mt-1 text-[12px] text-text-faint">
          来自 resident daemon registry；每个 repo 的投影、历史、选择与收藏相互隔离。
        </p>
      </header>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-3 p-4">
        {repos.map((repo) => {
          const enabled = repo.registrationState === "enabled";
          return (
            <button
              key={repo.repoId}
              disabled={!enabled}
              onClick={() => onOpenProject(repo.repoId)}
              className={`rounded-lg border bg-surface p-3 text-left ${repo.repoId === currentRepoId ? "border-accent" : "border-border"} ${enabled ? "hover:border-border-strong" : "cursor-not-allowed opacity-65"}`}
            >
              <div className="flex items-center gap-2">
                <FolderSimple className="text-text-muted" />
                <b className="truncate text-[14px]">{repo.displayName}</b>
                <span className="ml-auto font-mono text-[10px] text-text-faint">{repo.repoId}</span>
              </div>
              <p className="mt-2 truncate font-mono text-[11px] text-text-faint">{repo.canonicalRoot}</p>
              <div className="mt-3 flex flex-wrap gap-1.5 font-mono text-[10px]">
                <Badge value={repo.registrationState} />
                <Badge value={repo.cellState} />
                <Badge value={`lock:${repo.lockState}`} />
                <Badge value={`queue:${repo.queueDepth ?? "unknown"}`} />
              </div>
              {repo.cellState !== "attached" && (
                <p className="mt-2 inline-flex items-start gap-1 text-[11px] text-status-blocked">
                  <WarningCircle className="mt-0.5 shrink-0" />
                  {repo.unavailableReason ?? repo.lastError ?? "unknown / 未投影"}
                </p>
              )}
              {!enabled && (
                <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-text-faint">
                  <LockKey />
                  disabled repo 仅解释，不可进入
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
function Badge({ value }: { readonly value: string }) {
  return <span className="rounded border border-border px-1.5 py-0.5 text-text-muted">{value}</span>;
}
