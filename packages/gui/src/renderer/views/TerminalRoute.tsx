import { useState } from "react";
import { openExternalUrl } from "../browser/open-external-url.ts";
import { useSettingsQuery, useSettingsMutation } from "../settings-data.ts";
import type { TaskRow } from "../model/types.ts";
import type { AppLocation } from "../navigation/viewHistory.ts";
import { TerminalView, type TerminalLaunchTask, type TerminalAttachSession } from "./TerminalView.tsx";

/**
 * App 外壳里终端页的接线面(自 App.tsx 按职责拆出):只做 props 适配——任务行裁剪成
 * 终端树需要的字段、URL 出口按本机设置分流。
 */
export function TerminalRoute({
  repoId,
  daemonGeneration,
  repoRoot,
  tasks,
  launchTask,
  attachSession,
  onSessionExit,
  navigate,
  onNavigateEntity,
  onOpenDocument,
}: {
  readonly repoId: string;
  readonly daemonGeneration: number | null;
  readonly repoRoot: string | null;
  readonly tasks: readonly TaskRow[];
  readonly launchTask: TerminalLaunchTask | null;
  readonly attachSession?: TerminalAttachSession | null;
  readonly onSessionExit?: (sessionId: string) => void;
  readonly navigate: (fields: Partial<AppLocation>) => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly onOpenDocument: (path: string) => void;
}) {
  const settings = useSettingsQuery(repoId);
  const { mutate: saveSettings, isPending: settingsPending, error: settingsError } = useSettingsMutation(repoId);
  const [openError, setOpenError] = useState<string | null>(null);
  const terminalBrowser = settings.data?.settings.gui?.terminalBrowser ?? "embedded";
  return (
    <>
      <div role="alert" hidden={!openError && !settings.error && !settingsError}>
        {openError ?? settings.error?.message ?? settingsError?.message}
      </div>
      <TerminalView
        repoId={repoId}
        daemonGeneration={daemonGeneration}
        tasks={tasks.map(({ taskId, title, parentTaskId, coordinationStatus, createdAt }) => ({
          taskId,
          title,
          parentTaskId,
          status: coordinationStatus,
          createdAt,
        }))}
        repoRoot={repoRoot}
        launchTask={launchTask}
        attachSession={attachSession}
        onSessionExit={onSessionExit}
        onNavigateEntity={onNavigateEntity}
        onOpenDocument={onOpenDocument}
        terminalBrowser={terminalBrowser}
        browserSettingPending={settings.isPending || !!settings.error || settingsPending}
        onTerminalBrowserChange={(guiTerminalBrowser) => saveSettings({ guiTerminalBrowser })}
        openUrl={(uri) => {
          setOpenError(null);
          // A CLI command may have changed the local file inside this very terminal;
          // read it for this gesture instead of waiting for the presentation poll.
          void settings
            .refetch({ throwOnError: true })
            .then(async (current) => {
              if (!current.isSuccess) throw current.error;
              if (current.data.settings.gui?.terminalBrowser === "system") await openExternalUrl(uri);
              else
                navigate({
                  view: "browser",
                  browserUrl: uri,
                  focusedEntityRef: null,
                  selectedId: null,
                  previewId: null,
                });
            })
            .catch((cause: unknown) => {
              setOpenError(cause instanceof Error ? cause.message : String(cause));
            });
        }}
      />
    </>
  );
}
