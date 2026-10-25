/**
 * Public evidence index: governance entities that gate-allowlist refs may cite.
 *
 * The private ledger (harness/) never enters this repository, so public CI
 * cannot resolve a `ref` citation against it directly. This module is the
 * exported bridge: every id below was verified to exist in the ledger on the
 * syncedAt date (task packages under harness/tasks/, decision packages under
 * harness/decisions/, `### Dn` sections of the ADR files, ledger documents
 * under the repository root). The B13 gate (allowlist-path-existence.mjs)
 * audits every allowlist ref against this index.
 *
 * Scope is the cited superset — every entity cited by the JSON allowlists in
 * tools/gate-allowlists plus the task cited by the B13 path fixture — not a
 * full ledger export: each row stays load-bearing and the file stays
 * reviewable. When a new allowlist citation lands, add its verified id here
 * in the same PR; the gate turns red until you do. Rows are never removed
 * while cited.
 */
export const EVIDENCE_INDEX = Object.freeze({
  schema: "harness-anything/evidence-index/v1",
  syncedAt: "2026-10-21",
  tasks: Object.freeze([
    "task_01130d097481420c8d59e1fe08",
    "task_01KWGEEEFS13Z4HNVHZSYZ9Z3E",
    "task_01KWNFNGG9H41724SADGFSMEZ3",
    "task_01KWW57DZR16BD31BC84ETQV6E",
    "task_01KZQ944F7RH6E0153Q3Q86Y63",
    "task_01KZRMKJT7YKQ2TNXA8WR1W5DN",
    "task_01KZRMKPA7XGF0NGBE961MCGET",
    "task_01KZRMM35JQWZP5SCMW8GD366E",
    "task_01KZWTC8HNP2PVNEAQ02TWDTHF",
    "task_01KZWZEW11C499EACS9M5HVJZ8",
    "task_01KZXGJWVCKCA6B0MKB220PKFB",
    "task_038b4d6f3f596f842702719458",
    "task_03cb7a92053c5b072005256d57",
    "task_0bff009657f2a466ee187c8210",
    "task_1de89b0fd52d2c7a67617d1a2a",
    "task_237d96e30287e4c2552826ef46",
    "task_2c42314f552452ad44d90f8dfe",
    "task_32e553b6c0ff5f31a6d914e5cb",
    "task_39cc8158d2f76a930bf4dcd0de",
    "task_427b738002d4d6c9c42a4cf010",
    "task_432d80554372b23108826e04d1",
    "task_4ed6d8c8faebdbcfc484745ceb",
    "task_6d28fb8546ca9bb75ddc0df38b",
    "task_6d53132ed7dcc47c4cb967756b",
    "task_6d847ff57bf88357cfd7c64f8e",
    "task_6dc29e76828cbad9820bf6a2f7",
    "task_6e3a253ed79c2c458543c7d3d7",
    "task_799ca104a7af7b18432b2ded54",
    "task_94cac93e5083d72bb45f5f9577",
    "task_aceaabaedfedcf9cb062ccf883",
    "task_b79a4d997e73987b0a42c62433",
    "task_c877b09412a2fb723cd03d2b16",
    "task_d70f45787a59cbd65469f5b3c4",
    "task_e3d34df53e78784cdd51048c5e",
    "task_ee928d2898ddd8ef9684900e9b",
    "task_f16581aa37aadc9e00699729d7",
    "task_f2f6f35cfb02adcf4df7fd1ad1",
    "task_f4b56d482e26280d51859359aa",
    "task_f821cb831f535a13d8cc857c3c",
    "task_f9a37aaa70e746826eb3aa11f8",
  ]),
  decisions: Object.freeze([
    "dec_01KZVA9GQFJ0T6H05RHCSTV4CE",
    "dec_13FF6AEF3598AF34DC8F4A0558",
    "dec_57A9D27BA446C23759A08B1C13",
    "dec_585DB10A4218D9FA00F67B9537",
    "dec_5EC2631352B17EE2BF4979E37E",
    "dec_78A329289D1AA69527529DA92C",
    "dec_9284BD6119D453EEECEED62450",
    "dec_99000027E6BCC263E341D38DC0",
    "dec_B1F5FF7648436C985F38F14226",
    "dec_B284A85A2078145597CEF8D733",
    "dec_EF5F3820E81FB8A5266F1F3342",
    "dec_F906FA4E1BE047B6F591CF4316",
    "dec_FC8D4B2DE22E97774073A0BBF9",
    "dec_mra9ag8o",
  ]),
  adrs: Object.freeze({
    "ADR-0022": Object.freeze(["D3", "D6"]),
    "ADR-0023": Object.freeze(["D6"]),
  }),
  documents: Object.freeze(["harness/contracts/41-port-discipline-contracts.md#1"]),
});
