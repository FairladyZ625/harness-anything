const authorityBootstrapRequirement = "authority manifest, harness/people.yaml, and authority key registry/key material";
const authorityBootstrapRecovery = "run `ha init`, then restart the daemon with `ha daemon stop && ha daemon start --service`, and retry the command";

export function authorityPlannerUnavailableHint(message: string): string {
  return `${message} The active daemon requires the initialized canonical authority composition (${authorityBootstrapRequirement}). Next: ${authorityBootstrapRecovery}.`;
}
