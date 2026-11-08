import { assessTransitionDocument, type MarkdownDocumentContract } from "@harness-anything/kernel";

// Negative control: the canonical body comes from the projection read port and the kernel judges
// it. The single-definition gate must accept this consumer.
export function canonicalPlanReadiness(
  projection: { readDocument(path: string): { readonly document: { readonly body: string } | null } },
  taskPlanPath: string,
  contract: MarkdownDocumentContract,
): boolean {
  const document = projection.readDocument(taskPlanPath).document;
  return document !== null && assessTransitionDocument("task.plan", document.body, contract).ready;
}
