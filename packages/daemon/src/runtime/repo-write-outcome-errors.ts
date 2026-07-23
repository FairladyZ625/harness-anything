export class RepoWriteOutcomeValidationError extends Error {
  readonly code = "REPO_WRITE_OUTCOME_INVALID";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "RepoWriteOutcomeValidationError";
  }
}
