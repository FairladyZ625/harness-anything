import { defineCommandSpecs } from "./types.ts";
import { parseAuthorityCutoverArgs } from "../parsers/authority-cutover.ts";
import { parseAuthorityRepoArgs } from "../parsers/authority-repo.ts";
import { runAuthorityCutoverCommand } from "../../commands/core/authority-cutover.ts";
import { runAuthorityRepoCommand } from "../../commands/core/authority-repo.ts";

const shared = {
  receiptContract: { data: ["report"], paths: [], successNext: { kind: "none" }, },
  eventPolicy: { conflictMarkerPreflight: false, runtimeEvent: "none" }
} as const;

export const authorityCutoverCommandSpecs = defineCommandSpecs([
  { kind: "authority-cutover-status", usage: "authority cutover status [--json]", options: [{ flag: "--json", description: "Emit command-receipt/v2 JSON." }], summary: "Read durable authority cutover control state.", examples: ["harness-anything authority cutover status --json"], parse: parseAuthorityCutoverArgs, run: runAuthorityCutoverCommand, ...shared },
  { kind: "authority-cutover-drain", usage: "authority cutover drain [--classify <op-id|disposition|tuple-digest|evidence-ref>]... [--json]", options: [{ flag: "--classify", description: "Classify a non-terminal operation against its exact recorded protocol tuple digest; repeat as needed." }, { flag: "--json", description: "Emit command-receipt/v2 JSON." }], summary: "Close authority admission and durably drain or classify every non-terminal operation.", examples: ["harness-anything authority cutover drain --json"], parse: parseAuthorityCutoverArgs, run: runAuthorityCutoverCommand, ...shared },
  { kind: "authority-cutover-scan", usage: "authority cutover scan [--json]", options: [{ flag: "--json", description: "Emit command-receipt/v2 JSON." }], summary: "Run an independent production repository final scan and persist its receipt.", examples: ["harness-anything authority cutover scan --json"], parse: parseAuthorityCutoverArgs, run: runAuthorityCutoverCommand, ...shared },
  { kind: "authority-cutover-confirm", usage: "authority cutover confirm --first-scan <id> --second-scan <id> [--json]", options: [{ flag: "--first-scan", description: "Select the first durable scan receipt." }, { flag: "--second-scan", description: "Select a distinct second durable scan receipt." }, { flag: "--json", description: "Emit command-receipt/v2 JSON." }], summary: "Persist exact equality or mismatch for two independent final scans.", examples: ["harness-anything authority cutover confirm --first-scan scan_1 --second-scan scan_2 --json"], parse: parseAuthorityCutoverArgs, run: runAuthorityCutoverCommand, ...shared },
  { kind: "authority-cutover-boundary", usage: "authority cutover boundary --id <id> --equality <receipt-id> --expected-v2-tuple-digest <sha256> [--json]", options: [{ flag: "--id", description: "Name the durable cutover boundary." }, { flag: "--equality", description: "Select a passing double final-scan equality receipt." }, { flag: "--expected-v2-tuple-digest", description: "Pin the exact selected V2 protocol tuple digest." }, { flag: "--json", description: "Emit command-receipt/v2 JSON." }], summary: "Activate the named V2 authority boundary while retaining V1 read-only compatibility.", examples: ["harness-anything authority cutover boundary --id sme-v2 --equality equality_1 --expected-v2-tuple-digest <sha256> --json"], parse: parseAuthorityCutoverArgs, run: runAuthorityCutoverCommand, ...shared },
  { kind: "authority-cutover-freeze", display: "advanced", usage: "authority cutover freeze --reason <text> --boundary-receipt-digest <sha256> [--json]", options: [{ flag: "--reason", description: "Record the containment reason." }, { flag: "--boundary-receipt-digest", description: "Pin the active boundary receipt digest." }, { flag: "--json", description: "Emit command-receipt/v2 JSON." }], summary: "Freeze authority writes without restoring the retired V1 fresh writer.", examples: ["harness-anything authority cutover freeze --reason \"forward fix\" --boundary-receipt-digest <sha256> --json"], parse: parseAuthorityCutoverArgs, run: runAuthorityCutoverCommand, ...shared },
  { kind: "authority-cutover-re-enable", display: "advanced", usage: "authority cutover re-enable --boundary <id> --freeze-receipt-digest <sha256> --equality <receipt-id> --forward-fix <ref> [--json]", options: [{ flag: "--boundary", description: "Pin the active boundary id." }, { flag: "--freeze-receipt-digest", description: "Pin the containment receipt digest." }, { flag: "--equality", description: "Select a new passing equality receipt recorded after freeze." }, { flag: "--forward-fix", description: "Record the verified forward-fix evidence reference." }, { flag: "--json", description: "Emit command-receipt/v2 JSON." }], summary: "Re-enable V2 admission after frozen-state rescans and a verified forward fix.", examples: ["harness-anything authority cutover re-enable --boundary sme-v2 --freeze-receipt-digest <sha256> --equality equality_2 --forward-fix fix/w6-1 --json"], parse: parseAuthorityCutoverArgs, run: runAuthorityCutoverCommand, ...shared },
  {
    kind: "authority-repo-enroll",
    usage: "authority repo enroll --repo-id <id> --repo-root <path> --manifest <path> --service-state-root <path> [--key-registry <path>] [--namespace-ttl-ms <ms>] [--allow-executor <agent-id>]... [--json]",
    options: [
      { flag: "--repo-id", description: "Stable repository id to enroll." },
      { flag: "--repo-root", description: "Canonical repository root; private key material is forbidden below it." },
      { flag: "--manifest", description: "Authority production manifest to create or extend." },
      { flag: "--service-state-root", description: "External service-state root for the authority key store." },
      { flag: "--key-registry", description: "Optional external authority key registry path." },
      { flag: "--namespace-ttl-ms", description: "Optional positive operation-namespace lifetime in milliseconds." },
      { flag: "--allow-executor", description: "Executor agent id allowed by the new repository manifest; repeat to add ids." },
      { flag: "--json", description: "Emit command-receipt/v2 JSON." }
    ],
    summary: "Generate and pin an independent authority key, registry, and signed manifest entry for a repository; then start its daemon and make the first governance write.",
    examples: [
      "harness-anything authority repo enroll --repo-id billing --repo-root . --manifest /var/lib/ha/authority-production.json --service-state-root /var/lib/ha/service-state --json",
      "ha --repo billing daemon start --service --authority-manifest /var/lib/ha/authority-production.json --json",
      "ha --repo billing task create --title \"first governance write\" --json"
    ],
    parse: parseAuthorityRepoArgs,
    run: runAuthorityRepoCommand,
    receiptContract: { data: ["report"], paths: ["primary"], successNext: { kind: "none" }, },
    eventPolicy: { conflictMarkerPreflight: false, runtimeEvent: "none" }
  },
  {
    kind: "authority-repo-resign",
    usage: "authority repo resign --repo-id <id> --manifest <path> [--key-registry <path>] [--switch-record <path>] [--namespace-ttl-ms <ms>] [--json]",
    options: [
      { flag: "--repo-id", description: "Repository id whose current trust domain will be replaced." },
      { flag: "--manifest", description: "Existing authority production manifest." },
      { flag: "--key-registry", description: "Optional external path for the new public key registry." },
      { flag: "--switch-record", description: "Optional external path for the prepared/applied trust-domain switch record." },
      { flag: "--namespace-ttl-ms", description: "Optional positive operation-namespace lifetime in milliseconds." },
      { flag: "--json", description: "Emit command-receipt/v2 JSON." }
    ],
    summary: "Resign one repository into a new trust domain and retain verifiable previous-domain evidence.",
    examples: ["harness-anything authority repo resign --repo-id billing --manifest /var/lib/ha/authority-production.json --json"],
    parse: parseAuthorityRepoArgs,
    run: runAuthorityRepoCommand,
    receiptContract: { data: ["report"], paths: ["primary"], successNext: { kind: "none" }, },
    eventPolicy: { conflictMarkerPreflight: false, runtimeEvent: "none" }
  }
]);
