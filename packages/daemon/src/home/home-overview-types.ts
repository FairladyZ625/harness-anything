import type { DaemonRepoMode } from "@harness-anything/kernel";

/**
 * 跨仓库主页聚合结果(dec_C612E69B7C7E3480A5F9D2CAD3 / dec_66CE6F92D92CE3424C44B985D2):
 * daemon 侧唯一的跨仓聚合读，供 GUI 重构区「主页」一屏尽览所有活跃、离线与静止仓库。
 */
export interface DaemonHomeMatter {
  readonly key: string;
  readonly tag: string;
  readonly text: string;
  readonly tone: "danger" | "warning" | "active" | "neutral" | "done";
  readonly taskId?: string;
  readonly ref?: string;
}

export interface DaemonHomeRepoOverview {
  readonly repoId: string;
  readonly displayName: string;
  readonly canonicalRoot: string | null;
  readonly authoredBranch: string | null;
  readonly registrationState: "enabled" | "disabled";
  readonly connectionId?: string;
  readonly mode: DaemonRepoMode;
  readonly cellState: "attached" | "warming" | "unavailable" | "not_loaded";
  readonly status: "online" | "warming" | "unavailable" | "offline";
  readonly unavailableReason: string | null;
  /** 等你处理 N(attn 桶未结事项计数);离线/未附着为 null */
  readonly waitingCount: number | null;
  /** 正在跑 N(live 会话总数);离线/未附着为 null */
  readonly runningCount: number | null;
  /** 刚交付 N(24小时内完成任务数);离线/未附着为 null */
  readonly deliveredCount: number | null;
  /** 最要紧的 1~3 件事各一句话(人话摘要) */
  readonly topMatters: readonly DaemonHomeMatter[];
  /** 是否静止仓库(0等你 + 0在跑 + 0刚交付且无近期活动;供前端折叠收纳) */
  readonly isQuiet: boolean;
  readonly lastActivityAt: string | null;
}

export interface DaemonHomeOverviewResult {
  readonly schema: "daemon.gui.home-overview/v1";
  readonly ok: true;
  readonly observedAt: string;
  readonly repos: readonly DaemonHomeRepoOverview[];
}
