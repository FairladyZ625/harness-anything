import { t } from "../i18n/index.tsx";

/**
 * registry v2 模式徽标(PLT-EdgeGUI-W3):侧栏当前仓、System 仓库表、
 * 仓库与连接页共用一份呈现口径 —— 纯本地 / 纯展示 / 边缘 / 中心。
 */

export type RepoMode = "local" | "remote-proxy" | "remote-center" | "remote-edge";

const MODE_LABEL: Record<RepoMode, () => string> = {
  local: () => t("components.repoMode.local"),
  "remote-proxy": () => t("components.repoMode.remoteProxy"),
  "remote-center": () => t("components.repoMode.remoteCenter"),
  "remote-edge": () => t("components.repoMode.remoteEdge"),
};

const MODE_CLASS: Record<RepoMode, string> = {
  local: "border-border text-text-muted",
  "remote-proxy": "border-accent/40 text-accent",
  "remote-center": "border-status-done/40 text-status-done",
  "remote-edge": "border-status-done/40 text-status-done",
};

export function repoModeLabel(mode: RepoMode): string {
  return MODE_LABEL[mode]();
}

export function RepoModeBadge({ mode, title }: { readonly mode: RepoMode; readonly title?: string }) {
  return (
    <span
      data-testid={`repo-mode-badge-${mode}`}
      title={title ?? repoModeLabel(mode)}
      className={`inline-flex shrink-0 items-center rounded border px-1 py-px font-mono ui-micro ${MODE_CLASS[mode]}`}
    >
      {repoModeLabel(mode)}
    </span>
  );
}
