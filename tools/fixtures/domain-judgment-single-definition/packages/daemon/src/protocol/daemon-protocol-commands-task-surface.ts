// Positive-control fixture: transport metadata must not decide cancellation eligibility for the CLI.
export const input = {
  requiredWhen: { field: "status", values: ["cancelled"] },
};
