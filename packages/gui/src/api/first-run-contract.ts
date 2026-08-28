export const FIRST_RUN_CHOOSE_CHANNEL = "harness:firstRun:chooseRepository";
export const FIRST_RUN_BOOTSTRAP_CHANNEL = "harness:firstRun:bootstrap";

export interface FirstRunBootstrapInput {
  readonly rootDir: string;
  readonly repoId: string;
  readonly personId: string;
  readonly displayName: string;
  readonly name?: string;
  readonly addNpmScripts?: boolean;
}

export interface FirstRunApi {
  readonly chooseRepository: () => Promise<string | null>;
  readonly bootstrap: (input: FirstRunBootstrapInput) => Promise<unknown>;
}
