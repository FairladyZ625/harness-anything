import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 视图级错误边界。子树(如某个终端 pane)在渲染/挂载期抛错时,兜底为一个可恢复面板,
 * 而不是让抛错一路冒泡把整棵 React 树卸载成黑屏——App 此前没有边界,一个 pane 崩溃
 * 就拖黑整个窗口,连侧边栏都没了。挂在 pane/视图外层:其余部分不受影响。文案内联
 * (不走 i18n),因为崩溃路径不应再依赖可能同样出错的子系统。
 */
interface Props {
  readonly children: ReactNode;
}
interface State {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary] 视图渲染出错:", error, info.componentStack);
  }

  private readonly reset = (): void => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="grid min-h-0 flex-1 place-items-center p-6">
        <div className="max-w-lg rounded-lg border border-border bg-surface-raised p-5 text-center">
          <p className="text-sm font-medium text-text">此视图出现错误</p>
          <p className="mt-0.5 ui-micro text-text-faint">This view hit an error</p>
          <p
            className={
              "mt-3 max-h-40 overflow-auto break-words rounded border border-border bg-surface " +
              "p-2 text-left font-mono ui-micro text-status-blocked"
            }
          >
            {error.message || String(error)}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              onClick={this.reset}
              className={"rounded border border-accent/60 bg-accent/10 px-3 py-1 ui-meta text-text hover:bg-accent/20"}
            >
              重试 · Retry
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded border border-border px-3 py-1 ui-meta text-text-muted hover:bg-surface"
            >
              重新加载 · Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
