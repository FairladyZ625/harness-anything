import { t } from "../i18n/index.tsx";
import { useEffect, useState } from "react";
import { guiHostBridge } from "../gui-transport.ts";

type DesktopSetupFailureView = {
  readonly step: "terminal-command" | "shell-path" | "background-service";
  readonly reason: string;
  readonly hint: string;
};

type DesktopStatus = {
  readonly node?: { readonly available: boolean; readonly version: string | null; readonly path: string };
  readonly path?: { readonly includesShim: boolean; readonly shellRc: string };
  readonly npmHa?: string | null;
  readonly daemon?: { readonly reachable: boolean; readonly serviceInstalled: boolean };
  readonly shim?: { readonly installed: boolean; readonly preservedExistingHa: boolean; readonly path: string };
  readonly setupFailures?: readonly DesktopSetupFailureView[];
};

const DESKTOP_FIRST_RUN_DONE = "harness.desktop-first-run.done";

const desktopStepLabels: Record<DesktopSetupFailureView["step"], string> = {
  "terminal-command": "终端命令",
  "shell-path": "PATH",
  "background-service": "后台服务",
};

/** The app's first-launch system setup is a startup surface, not a sidebar view. */
export function DesktopFirstRunGuide() {
  const bridge = guiHostBridge()?.firstRun;
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [dismissed, setDismissed] = useState(() => window.localStorage.getItem(DESKTOP_FIRST_RUN_DONE) === "1");
  useEffect(() => {
    if (!bridge || dismissed) return;
    let active = true;
    const refresh = () => {
      void bridge.desktopStatus?.().then((value) => {
        if (active) setStatus((value ?? null) as DesktopStatus | null);
      });
    };
    // 先订阅再拉取:主进程后台安装完成的推送不会落在首份状态与订阅之间。
    const unsubscribe = bridge.onDesktopFirstRunUpdated?.(refresh);
    refresh();
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [bridge, dismissed]);
  if (!bridge || dismissed || status === null) return null;
  const setup = async () => {
    setRunning(true);
    try {
      const next = await bridge.desktopSetup?.();
      setStatus((next ?? status) as DesktopStatus);
    } finally {
      setRunning(false);
    }
  };
  const finish = () => {
    window.localStorage.setItem(DESKTOP_FIRST_RUN_DONE, "1");
    setDismissed(true);
  };
  const rows = [
    ["环境", status.node?.available === true, status.node?.version ? `Node ${status.node.version}` : "未找到内嵌 Node"],
    [
      "终端命令",
      status.shim?.installed === true,
      status.shim?.preservedExistingHa ? "已有 ha，已保留" : "App CLI shim",
    ],
    [
      "PATH",
      status.path?.includesShim === true,
      status.path?.includesShim ? "新终端即可使用" : `重开终端以使用 ${status.path?.shellRc ?? "shell rc"}`,
    ],
    [
      "后台服务",
      status.daemon?.serviceInstalled === true && status.daemon.reachable === true,
      status.daemon?.reachable ? "daemon 正在运行" : "已安装，等待启动",
    ],
  ] as const;
  const failures = status.setupFailures ?? [];
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Harness Anything 首次启动"
    >
      <section className="w-full max-w-xl rounded-2xl border border-accent/40 bg-surface-raised p-7 shadow-2xl">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">首次启动 · App 设置</p>
        <h1 className="mt-2 text-2xl font-semibold">电脑已准备好使用 Harness Anything</h1>
        <p className="mt-2 text-sm leading-6 text-text-muted">
          我们检查了内嵌运行环境、终端命令和后台服务。已有 npm 版 ha 不会被覆盖。
        </p>
        <div className="mt-6 grid gap-2">
          {rows.map(([label, ok, detail]) => (
            <div
              key={label}
              className="flex items-center justify-between rounded-lg border border-border-subtle px-4 py-3"
            >
              <span className="text-sm font-medium">
                {ok ? "✓" : "○"} {label}
              </span>
              <span className="text-xs text-text-muted">{detail}</span>
            </div>
          ))}
        </div>
        {failures.length > 0 ? (
          <div className="mt-3 grid gap-2" data-testid="first-run-setup-failures">
            {failures.map((failure) => (
              <div
                key={failure.step}
                className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3"
                role="alert"
              >
                <p className="text-sm font-medium text-danger">
                  {desktopStepLabels[failure.step]}设置失败：{failure.reason}
                </p>
                <p className="mt-1 text-xs leading-5 text-text-muted">{failure.hint}</p>
              </div>
            ))}
          </div>
        ) : null}
        {status.npmHa ? <p className="mt-4 text-xs text-text-muted">检测到另一份 ha：{status.npmHa}</p> : null}
        <p className="mt-4 text-xs text-text-muted">如果刚刚修改了 PATH，请关闭并重新打开终端。</p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="rounded-md border border-border-subtle px-4 py-2 text-sm" onClick={finish}>
            稍后
          </button>
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white"
            disabled={running}
            onClick={() => void setup()}
          >
            {running ? "检查中…" : "重新检查并完成"}
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * 首个仓库添加成功后的两步引导(Provider → Agent)。原独立首次运行对话框已并入
 * Settings → 仓库与连接(PLT-EdgeGUI-W3);这个引导保留为轻量浮层,不再承载仓库创建。
 */
export function FirstRunGuide({
  stage,
  onNext,
  onFinish,
}: {
  readonly stage: "provider" | "agent";
  readonly onNext: () => void;
  readonly onFinish: () => void;
}) {
  const provider = stage === "provider";
  return (
    <aside
      data-testid="first-run-guide"
      className="fixed right-5 bottom-5 z-50 w-80 rounded-xl border border-accent/50 bg-surface-raised p-4 shadow-2xl"
    >
      <p className="font-mono ui-micro uppercase tracking-widest text-accent">
        {t(provider ? "firstRun.stepProvider" : "firstRun.stepAgent")}
      </p>
      <h2 className="mt-1 text-base font-semibold">{t(provider ? "firstRun.providerTitle" : "firstRun.agentTitle")}</h2>
      <p className="mt-2 text-xs leading-5 text-text-muted">
        {t(provider ? "firstRun.providerHint" : "firstRun.agentHint")}
      </p>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          data-testid={provider ? "first-run-next-agent" : "first-run-finish"}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white"
          onClick={provider ? onNext : onFinish}
        >
          {t(provider ? "firstRun.nextAgent" : "firstRun.finish")}
        </button>
      </div>
    </aside>
  );
}
