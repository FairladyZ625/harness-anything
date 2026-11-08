import { t } from "../i18n/index.tsx";

/**
 * Shared shell banner for a GUI bundle that does not match the attached daemon build. Both
 * identities come from existing `dist/build-id.txt` artifacts: main overlays the GUI's own
 * marker, the daemon reports its `build.commitSha` in `gui-system-status/v1`.
 */
export function GuiBuildWarningBanner({
  guiCommit,
  daemonCommit,
}: {
  readonly guiCommit: string | null | undefined;
  readonly daemonCommit: string | null | undefined;
}) {
  if (!guiCommit || !daemonCommit || guiCommit === daemonCommit) return null;
  return (
    <p
      data-testid="gui-build-warning-banner"
      className="border-b border-status-blocked bg-surface-raised px-5 py-2 ui-meta text-status-blocked"
    >
      {t("gui.versionBehind", {
        gui: guiCommit.slice(0, 12),
        daemon: daemonCommit.slice(0, 12),
        command: "npm run build -w @harness-anything/gui",
      })}
    </p>
  );
}
