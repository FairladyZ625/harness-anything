export class RepoWriteOutcomeValidationError extends Error {
  readonly code = "REPO_WRITE_OUTCOME_INVALID";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "RepoWriteOutcomeValidationError";
  }
}

export class RepoWriteOutcomeConflictError extends Error {
  readonly code = "REPO_WRITE_OUTCOME_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "RepoWriteOutcomeConflictError";
  }
}

export class RepoWriteOutcomeCorruptionError extends Error {
  readonly code = "REPO_WRITE_OUTCOME_CORRUPT";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "RepoWriteOutcomeCorruptionError";
  }
}

export class RepoWriteOutcomeUnsupportedPlatformError extends Error {
  readonly code = "REPO_WRITE_OUTCOME_PLATFORM_UNSUPPORTED";

  constructor() {
    super("repo-write outcome durability is unsupported on win32");
    this.name = "RepoWriteOutcomeUnsupportedPlatformError";
  }
}

export class RepoWriteOutcomeGenerationFenceError extends Error {
  readonly code = "REPO_WRITE_OUTCOME_GENERATION_FENCED";

  constructor(message: string) {
    super(message);
    this.name = "RepoWriteOutcomeGenerationFenceError";
  }
}
