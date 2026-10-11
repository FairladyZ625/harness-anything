/**
 * 鼠标侧键的后退/前进(业主 2026-10-11):Windows 上侧键被操作系统转成
 * WM_APPCOMMAND,主进程收 `app-command` 事件,DOM 层拿不到 mousedown 3/4;
 * macOS/Linux 则只到 DOM、没有 app-command。两条路径互补,不会双触发:
 * 主进程只把 browser-backward/forward 转发到这一条通道,renderer 的统一
 * 导航历史(useViewHistory.back/forward)是唯一消费点。
 */
export const APP_COMMAND_CHANNEL = "harness:app-command";

export type AppNavigationCommand = "back" | "forward";

export interface AppCommandApi {
  /** 订阅主进程转发的鼠标侧键后退/前进;返回取消订阅函数。 */
  readonly onNavigationCommand: (listener: (command: AppNavigationCommand) => void) => () => void;
}
