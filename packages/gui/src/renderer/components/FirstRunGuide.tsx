import { t } from "../i18n/index.tsx";

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
