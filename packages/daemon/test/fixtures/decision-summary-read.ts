/** A minimal decision summary read as the GUI overview consumes it: one in-effect decision, no warnings. */
export function decisionSummaryRead() {
  return {
    ok: true,
    projection: "summary",
    decisions: [
      {
        decisionId: "dec_1",
        title: "Title",
        state: "in_effect",
        riskTier: "medium",
        urgency: "medium",
        proposedAt: "2026-09-11T00:00:00.000Z",
      },
    ],
    warnings: [],
  };
}
