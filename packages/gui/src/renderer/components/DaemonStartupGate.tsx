import { useEffect, useState, type ReactNode } from "react";
import { daemonErrorCode, daemonStartupPhase, isRetryableDaemonError } from "../daemon-startup.ts";
import { useSystemStatusQuery } from "../system-data.ts";

export function DaemonStartupGate({ children }: { readonly children: ReactNode }) {
  const systemQuery = useSystemStatusQuery();
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (systemQuery.isSuccess) return;
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
    return () => window.clearInterval(timer);
  }, [startedAt, systemQuery.isSuccess]);
  const phase = daemonStartupPhase({
    pending: systemQuery.isPending,
    ready: systemQuery.isSuccess,
    elapsedMs,
  });
  if (phase === "ready") return children;
  const code = daemonErrorCode(systemQuery.error);
  const retryable = systemQuery.error === null || isRetryableDaemonError(systemQuery.error);
  if (!retryable || phase === "timeout")
    return (
      <main className="grid min-h-screen place-items-center bg-bg p-6" data-testid="daemon-startup-timeout">
        <section className="max-w-xl rounded-xl border border-danger/50 bg-surface p-6 text-center">
          <h1 className="ui-heading mb-2">Daemon 尚未就绪</h1>
          <p className="mb-4 text-text-muted">
            {code ? `原因：${code}。` : "等待已超过 30 秒。"} 请运行 <code>ha daemon status</code> 检查状态。
          </p>
          <button
            className="rounded-md bg-accent px-4 py-2 font-medium text-accent-fg"
            type="button"
            onClick={() => {
              setStartedAt(Date.now());
              setElapsedMs(0);
              void systemQuery.refetch();
            }}
          >
            重试
          </button>
        </section>
      </main>
    );
  return (
    <main className="grid min-h-screen place-items-center bg-bg p-6" data-testid="daemon-startup-waiting">
      <section className="max-w-xl text-center" role="status">
        <h1 className="ui-heading mb-2">正在等待 daemon</h1>
        <p className="text-text-muted">
          GUI 会自动重试；若 daemon 尚未启动，请在终端运行 <code>ha gui</code>。
        </p>
      </section>
    </main>
  );
}
