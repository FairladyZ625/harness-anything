/**
 * Shared decision machine-content reconstruction for the CH3 rename drill:
 * rebuilds the kernel's decision-machine-content/v1 semantic object from a
 * rendered decision.md frontmatter, exactly the fields decisionMachineDigest
 * commits to. Used by the replayer's digest proofs and by the cross-generation
 * digest pairing verifier — one reconstruction rule for both.
 */
import { readFrontmatter, readScalar } from "../../packages/kernel/src/markdown/frontmatter.ts";

export function decisionSemanticFromDocument(body, where) {
  const frontmatter = readFrontmatter(body);
  if (frontmatter === null) throw new Error(`${where}: decision frontmatter is missing`);
  const scalar = (key) => readScalar(frontmatter, key);
  const text = (key) => { const value = scalar(key); return value.startsWith("\"") ? JSON.parse(value) : value; };
  const json = (key) => { const value = scalar(key); return value === "" ? [] : JSON.parse(value); };
  return {
    schema: "decision-machine-content/v1",
    decisionId: scalar("decision_id"),
    title: text("title"), question: text("question"),
    riskTier: scalar("riskTier"), urgency: scalar("urgency"),
    vertical: text("vertical"), preset: text("preset"), decisionClass: scalar("decisionClass"),
    appliesTo: json("applies_to"),
    chosen: json("chosen"), rejected: json("rejected"), claims: json("claims"), relations: json("relations"),
  };
}
