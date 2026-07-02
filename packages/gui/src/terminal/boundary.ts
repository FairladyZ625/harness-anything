/** @slice-activation Slice 7.5 GUI terminal - Shell panel execution boundary is enforced when terminal host wiring lands. */
export interface ShellPanelPolicy {
  readonly spawnRequiresUserAction: true;
  readonly hiddenCommandInjectionAllowed: false;
  readonly outputCreatesTaskState: false;
  readonly outputCreatesEvidence: false;
}

export const shellPanelPolicy: ShellPanelPolicy = {
  spawnRequiresUserAction: true,
  hiddenCommandInjectionAllowed: false,
  outputCreatesTaskState: false,
  outputCreatesEvidence: false
};

export function classifyShellOutput(_chunk: string): { readonly displayOnly: true; readonly stateChange: false } {
  return {
    displayOnly: true,
    stateChange: false
  };
}
