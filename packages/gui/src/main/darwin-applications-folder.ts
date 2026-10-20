export interface ApplicationsFolderAppPort {
  readonly isPackaged: boolean;
  isInApplicationsFolder(): boolean;
  moveToApplicationsFolder(options?: {
    conflictHandler?: (conflictType: "exists" | "existsAndRunning") => boolean;
  }): boolean;
}

export interface ApplicationsFolderDialogPort {
  showMessageBox(options: {
    type?: "none" | "info" | "error" | "question" | "warning";
    buttons?: string[];
    defaultId?: number;
    cancelId?: number;
    message: string;
    detail?: string;
  }): Promise<{ response: number }>;
  showMessageBoxSync(options: {
    type?: "none" | "info" | "error" | "question" | "warning";
    buttons?: string[];
    defaultId?: number;
    cancelId?: number;
    message: string;
    detail?: string;
  }): number;
}

export interface EnsureApplicationsFolderOptions {
  readonly platform?: NodeJS.Platform;
  readonly app: ApplicationsFolderAppPort;
  readonly dialog: ApplicationsFolderDialogPort;
  readonly logError?: (message: string, error?: unknown) => void;
}

/**
 * macOS 首次打包运行时，若 app 不在「应用程序」目录（如 AppTranslocation 随机只读路径），
 * 弹出原生对话框提示移动。成功移动后 Electron 自动重启并返回 true；
 * 若用户选以后再说或移动失败，给出人话提示后返回 false 并继续启动，不吞错。
 */
export async function ensureApplicationsFolder(options: EnsureApplicationsFolderOptions): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return false;
  if (!options.app.isPackaged) return false;
  if (options.app.isInApplicationsFolder()) return false;

  const promptResult = await options.dialog.showMessageBox({
    type: "question",
    buttons: ["移动到「应用程序」", "以后再说"],
    defaultId: 0,
    cancelId: 1,
    message: "是否将 Harness Anything 移动到「应用程序」目录？",
    detail: "从「应用程序」目录运行可以避免 macOS 随机只读路径限制，确保后台服务稳定运行。",
  });

  if (promptResult.response !== 0) {
    return false;
  }

  let conflictReason: string | null = null;
  let moved: boolean;

  try {
    moved = options.app.moveToApplicationsFolder({
      conflictHandler: (conflictType) => {
        if (conflictType === "exists") {
          const choice = options.dialog.showMessageBoxSync({
            type: "question",
            buttons: ["替换", "取消"],
            defaultId: 0,
            cancelId: 1,
            message: "「应用程序」目录已存在同名应用",
            detail: "是否用当前版本替换「应用程序」目录中已有的 Harness Anything？",
          });
          const shouldReplace = choice === 0;
          if (!shouldReplace) {
            conflictReason = "已取消替换现有应用";
          }
          return shouldReplace;
        }
        if (conflictType === "existsAndRunning") {
          options.dialog.showMessageBoxSync({
            type: "warning",
            buttons: ["好"],
            defaultId: 0,
            message: "「应用程序」目录中的 Harness Anything 正在运行",
            detail: "请先退出正在运行的应用后再试。",
          });
          conflictReason = "「应用程序」目录中的应用正在运行";
          return false;
        }
        return true;
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    options.logError?.("Failed to move application to Applications folder:", error);
    await options.dialog.showMessageBox({
      type: "warning",
      buttons: ["继续启动"],
      defaultId: 0,
      message: "移动到「应用程序」目录失败",
      detail: `${reason}。应用将继续在当前路径启动。`,
    });
    return false;
  }

  if (!moved) {
    const reason = conflictReason ?? "移动操作未完成或已取消";
    options.logError?.(`Failed to move application to Applications folder: ${reason}`);
    await options.dialog.showMessageBox({
      type: "warning",
      buttons: ["继续启动"],
      defaultId: 0,
      message: "未能移动到「应用程序」目录",
      detail: `${reason}。应用将继续在当前路径启动。`,
    });
    return false;
  }

  return true;
}
