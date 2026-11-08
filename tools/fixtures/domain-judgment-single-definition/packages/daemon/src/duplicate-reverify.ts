// Positive control (dec_BEFCF7D0484E901F187C2C8EC6): a daemon-side copy of the "is a re-review owed"
// judgment. The gate must refuse both the second route definition and the reverify comparison.
type Finding = { readonly blocking: boolean; readonly reverify?: string };

export function reviewReverifyRoute(findings: readonly Finding[]): "owner-verify" | "re-review" {
  return findings.every((finding) => !finding.blocking || finding.reverify === "owner-verify")
    ? "owner-verify"
    : "re-review";
}
