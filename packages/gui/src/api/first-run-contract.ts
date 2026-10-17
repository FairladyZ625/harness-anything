export const FIRST_RUN_CHOOSE_CHANNEL = "harness:firstRun:chooseRepository";
export const FIRST_RUN_BOOTSTRAP_CHANNEL = "harness:firstRun:bootstrap";
export const DESKTOP_FIRST_RUN_STATUS_CHANNEL = "harness:firstRun:desktopStatus";
export const DESKTOP_FIRST_RUN_SETUP_CHANNEL = "harness:firstRun:desktopSetup";
export const DESKTOP_FIRST_RUN_UPDATED_CHANNEL = "harness:firstRun:desktopUpdated";

export interface FirstRunBootstrapInput {
  readonly rootDir: string;
  readonly repoId: string;
  readonly personId: string;
  readonly displayName: string;
  readonly name?: string;
  readonly addNpmScripts?: boolean;
}

/** A failed first-run setup step, carried to the guide screen as which step / why / what to do. */
export interface DesktopSetupFailure {
  readonly step: "terminal-command" | "shell-path" | "background-service";
  readonly reason: string;
  readonly hint: string;
}

export interface FirstRunApi {
  readonly desktopStatus?: () => Promise<unknown>;
  readonly desktopSetup?: () => Promise<unknown>;
  readonly onDesktopFirstRunUpdated?: (listener: () => void) => () => void;
  readonly chooseRepository: () => Promise<string | null>;
  readonly bootstrap: (input: FirstRunBootstrapInput) => Promise<unknown>;
}
