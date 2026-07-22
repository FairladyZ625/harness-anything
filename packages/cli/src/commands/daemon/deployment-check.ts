export interface DaemonDeploymentCheckResult {
  readonly schema: "daemon-deployment-check/v1";
  readonly passed: boolean;
  readonly failures: ReadonlyArray<string>;
  readonly nextSteps: ReadonlyArray<string>;
}

export function evaluateDaemonDeploymentCheck(status: Record<string, unknown> | undefined): DaemonDeploymentCheckResult {
  const service = record(status?.service);
  const deployment = record(service?.deployment);
  if (!deployment) {
    return {
      schema: "daemon-deployment-check/v1",
      passed: false,
      failures: ["deployment-identity-capability-unavailable"],
      nextSteps: ["Run 'ha daemon upgrade --ref HEAD --json', then re-run 'ha daemon status --check --json'."]
    };
  }
  const failures = Array.isArray(deployment.failures)
    ? deployment.failures.filter((entry): entry is string => typeof entry === "string")
    : ["deployment-identity-invalid"];
  return {
    schema: "daemon-deployment-check/v1",
    passed: deployment.healthy === true && failures.length === 0,
    failures,
    nextSteps: failures.map(nextStepForFailure)
  };
}

function nextStepForFailure(failure: string): string {
  if (failure === "artifact-drift") {
    return "Run 'npm run build -w @harness-anything/cli' in the reported checkout, then run 'ha daemon refresh --json'.";
  }
  if (failure === "checkout-drift") {
    return "Run 'git -C <reported-checkout> status --short', reconcile that checkout to the intended commit, rebuild, then run 'ha daemon refresh --json'.";
  }
  if (failure === "dirty-build") {
    return "Commit or discard the changes shown by 'git -C <reported-checkout> status --short', rebuild, then run 'ha daemon refresh --json'.";
  }
  if (failure === "supervision-unverified") {
    return "Run 'ha daemon install-templates --out <directory>', install and start the host service-manager template, then re-run 'ha daemon status --check --json'.";
  }
  return "Run 'ha daemon upgrade --ref HEAD --json' to create verified build provenance, then re-run 'ha daemon status --check --json'.";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
