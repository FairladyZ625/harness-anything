const authorityBootstrapRequirement = "authority manifest, harness/people.yaml, and authority key registry/key material";
const authorityBootstrapRecovery = "run `ha daemon status --check --json` and inspect the loaded composition. Do not stop or restart the active daemon, and do not retry completion, until an operator has supplied and verified a replacement with the required authority manifest, people roster, and key material";

export function authorityPlannerUnavailableHint(message: string): string {
  return `${message} The active daemon requires the initialized canonical authority composition (${authorityBootstrapRequirement}). Next: ${authorityBootstrapRecovery}.`;
}
