export const artifactEntityImportGuidance = [
  "Select --mode explicitly:",
  "  reference records the locator without reading it. Use it in a personal or non-central repository when the original stays authoritative and should remain easy to update.",
  "  snapshot reads and stores observed bytes in Harness. Use it for file documents governed by a central repository.",
  "Reference locator kinds: repository-path, url (any absolute URL scheme), local-path (file URL), and external-key (provider:project:key). A local path is resolvable only on the registering node.",
  "Examples:",
  "  ha entity import --kind <kind> --locator https://example.invalid/minutes --locator-kind url --mode reference --expected-version 0",
  "  ha entity import --kind <kind> --locator docs/minutes.md --locator-kind repository-path --mode snapshot --expected-version 0",
].join("\n");
