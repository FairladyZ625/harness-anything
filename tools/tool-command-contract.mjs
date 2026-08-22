import { testTierNames } from "./test-tier-manifest.mjs";

function command(definition) {
  return Object.freeze({
    ...definition,
    options: Object.freeze(definition.options.map((option) => Object.freeze(option))),
    details: Object.freeze(definition.details ?? []),
  });
}

export const closeoutTaskCommand = command({
  id: "closeout-task",
  entry: "tools/closeout-task.mjs",
  summary: "Run an evidence-backed Task submission, review, consent, and completion sequence.",
  invalidInputShowsHelp: true,
  rejectDuplicateOptions: true,
  options: [
    { name: "--task-id", placeholder: "<task-id>", required: true, description: "Task to close out." },
    { name: "--execution-id", placeholder: "<execution-id>", required: true, description: "Active execution to submit." },
    { name: "--from-file", placeholder: "<judgment.json>", required: true, description: "Exact closeout judgment packet." },
  ],
  details: [
    "The judgment packet must contain exactly:",
    "  submission: completionClaim, deliverables, outputs, verificationNotes, knownGaps, residualRisks, commitSha",
    "  review: verdict, reason, evidenceChecked",
    "  consent: approved=true",
    "  completion: ci=passed, codeDocPaths[] (empty omits reconcile; an applicable code-doc gate may reject completion)",
    "",
    "The script derives the submitter and owner actor postures from the active task, binds Review to submission.commitSha,",
    "uses the transport human as independent reviewer, and invokes every existing lifecycle gate without bypasses.",
  ],
});

export const dispatchTaskCommand = command({
  id: "dispatch-task",
  entry: "tools/dispatch-task.mjs",
  summary: "Create, start, and detach a Task runtime from a caller-authored plan.",
  invalidInputShowsHelp: true,
  rejectDuplicateOptions: true,
  trimValues: true,
  options: [
    { name: "--plan-file", placeholder: "<task_plan.md>", required: true, description: "Caller-authored Task plan." },
    { name: "--preset", placeholder: "<preset-id>", required: true, description: "Preset used to create the Task." },
    { name: "--title", placeholder: "<title>", required: true, description: "Task title." },
    { name: "--instance", placeholder: "<runtime-instance-id>", required: true, description: "Runtime instance used for dispatch." },
    { name: "--prompt-file", placeholder: "<prompt-file>", description: "Optional runtime prompt file." },
  ],
  details: [
    "Creates the Task, writes the caller-authored plan to the packagePath returned by task create, acquires the execution lease,",
    "dispatches runtime run --detach, and returns the JSONL path plus a directly executable background sentinel command.",
    "The script does not generate plan/title judgments and does not monitor, retry, or resume the dispatched runtime.",
  ],
});

export const dispatchIsolatedTestCommand = command({
  id: "dispatch-isolated-test",
  entry: "tools/dispatch-isolated-test.mjs",
  summary: "Run one registered test tier or file in an isolated Ubuntu, Docker, or Windows target.",
  unknownOptionPrefix: "unknown dispatch-isolated-test option: ",
  options: [
    { name: "--target", placeholder: "<target>", values: Object.freeze(["ubuntu", "docker", "windows"]), defaultValue: "ubuntu", missingValue: "--target requires ubuntu, docker, or windows", invalidValue: (value) => `unknown target: ${value}; expected ubuntu, docker, or windows`, description: "Isolation target." },
    { name: "--tier", placeholder: "<tier>", values: testTierNames, missingValue: `--tier requires ${testTierNames.join(", ")}`, invalidValue: (value) => `unknown test tier: ${value}; expected ${testTierNames.join(", ")}`, description: "Registered test tier." },
    { name: "--file", placeholder: "<test-file>", missingValue: "--file requires a repository-relative test file", validate: validateTestFile, description: "POSIX repository-relative test file." },
  ],
  exactlyOne: Object.freeze([{ names: Object.freeze(["--tier", "--file"]), error: "choose exactly one of --tier or --file" }]),
});

export const testHermeticPreflightCommand = command({
  id: "test-hermetic-preflight",
  entry: "tools/test-hermetic-preflight.mjs",
  summary: "Verify that a test run cannot use the default daemon state or socket namespace.",
  unknownOptionPrefix: "unknown test-hermetic-preflight option: ",
  options: [
    { name: "--user-root", placeholder: "<path>", usageRequired: true, missingValue: "--user-root requires a value", description: "Dedicated test state root; must be passed explicitly to succeed." },
    { name: "--daemon-id", placeholder: "<id>", defaultValue: "default", missingValue: "--daemon-id requires a value", description: "Daemon socket namespace id." },
  ],
});

export const runNodeTestsCommand = command({
  id: "run-node-tests",
  entry: "tools/run-node-tests.mjs",
  summary: "Select registered Node test files and run them with watchdog and slow-test reporting.",
  unknownOptionPrefix: "unknown run-node-tests option: ",
  options: [
    { name: "--tier", placeholder: "<tier>", allowEquals: true, values: Object.freeze(["all", ...testTierNames]), defaultValue: "all", missingValue: "--tier requires a value", invalidValue: (value) => `unknown test tier: ${value}; expected all, ${testTierNames.join(", ")}`, description: "Test tier." },
    { name: "--list", kind: "boolean", description: "List selected files without running them." },
    { name: "--slow-threshold-ms", placeholder: "<milliseconds>", allowEquals: true, defaultValue: "1000", missingValue: "--slow-threshold-ms requires a value", validate: (value) => validateNonNegativeInteger(value, "--slow-threshold-ms"), description: "Non-negative slow-test threshold." },
    { name: "--slow-limit", placeholder: "<count>", allowEquals: true, defaultValue: "10", missingValue: "--slow-limit requires a value", validate: (value) => validateNonNegativeInteger(value, "--slow-limit"), description: "Non-negative number of slow tests to report." },
    { name: "--concurrency", placeholder: "<count>", allowEquals: true, missingValue: "--concurrency requires a value", validate: (value) => validateNonNegativeInteger(value, "--concurrency"), description: "Non-negative test process concurrency cap." },
    { name: "--prefix", placeholder: "<path>", allowEquals: true, repeatable: true, missingValue: "--prefix requires a value", validate: validateTestPrefix, description: "POSIX repository-relative path prefix." },
    { name: "--file", placeholder: "<test-file>", allowEquals: true, repeatable: true, missingValue: "--file requires a value", validate: validateTestFile, description: "Exact POSIX repository-relative test file." },
    { name: "--shard", placeholder: "<shard>", allowEquals: true, missingValue: "--shard requires a value", requiresValue: Object.freeze({ name: "--tier", value: "integration", error: "--shard is only supported with --tier integration" }), conflictsWith: Object.freeze([{ name: "--file", error: "--file cannot be combined with --shard" }]), description: "Integration shard." },
  ],
});

export const supportedToolCommands = Object.freeze([
  closeoutTaskCommand,
  dispatchTaskCommand,
  dispatchIsolatedTestCommand,
  testHermeticPreflightCommand,
  runNodeTestsCommand,
]);

export function renderToolHelp(descriptor) {
  const usage = descriptor.options.map((option) => {
    const value = option.kind === "boolean" ? option.name : `${option.name} ${option.placeholder}`;
    const repeated = option.repeatable ? `${value}...` : value;
    return option.required || option.usageRequired ? repeated : `[${repeated}]`;
  }).join(" ");
  const optionLines = descriptor.options.map((option) => {
    const value = option.kind === "boolean" ? option.name : `${option.name} ${option.placeholder}`;
    const metadata = [
      option.required ? "required" : option.usageRequired ? "required to succeed" : "optional",
      option.values ? `values: ${option.values.join(", ")}` : undefined,
      option.defaultValue !== undefined ? `default: ${option.defaultValue}` : undefined,
      option.repeatable ? "repeatable" : undefined,
      option.allowEquals ? `also accepts ${option.name}=${option.placeholder}` : undefined,
      option.requiresValue ? `requires ${option.requiresValue.name} ${option.requiresValue.value}` : undefined,
      option.conflictsWith ? `conflicts with ${option.conflictsWith.map(({ name }) => name).join(", ")}` : undefined,
    ].filter(Boolean).join("; ");
    return `  ${value}\n    ${metadata}; ${option.description}`;
  });
  const relations = (descriptor.exactlyOne ?? []).map(({ names }) => `  Exactly one of: ${names.join(", ")}.`);
  return [
    `Usage: node ${descriptor.entry}${usage ? ` ${usage}` : ""}`,
    "",
    descriptor.summary,
    ...(descriptor.details.length ? ["", ...descriptor.details] : []),
    "",
    "Options:",
    ...optionLines,
    ...relations,
    "  -h, --help",
    "    Show this help.",
  ].join("\n");
}

export function parseToolOptions(descriptor, argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { help: true, values: new Map(), booleans: new Set() };
  const options = new Map(descriptor.options.map((option) => [option.name, option]));
  const values = new Map(), booleans = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const exact = options.get(arg);
    const equals = exact === undefined ? descriptor.options.find((option) => option.allowEquals && arg.startsWith(`${option.name}=`)) : undefined;
    const option = exact ?? equals;
    if (option === undefined) throw invalidInput(descriptor, `${descriptor.unknownOptionPrefix ?? "unknown option: "}${arg}`);
    if (option.kind === "boolean") {
      booleans.add(option.name);
      continue;
    }
    const value = equals === undefined ? argv[index + 1] : arg.slice(option.name.length + 1);
    if (value === undefined || value.length === 0 || descriptor.trimValues && value.trim().length === 0) throw invalidInput(descriptor, option.missingValue ?? `${option.name} requires a value`);
    if (equals === undefined) index += 1;
    if (option.repeatable) values.set(option.name, [...values.get(option.name) ?? [], value]);
    else {
      if (descriptor.rejectDuplicateOptions && values.has(option.name)) throw new Error(`${option.name} may be supplied once.\n\n${renderToolHelp(descriptor)}`);
      values.set(option.name, [value]);
    }
  }
  const missing = descriptor.options.filter((option) => option.required && !values.has(option.name) && !booleans.has(option.name));
  if (missing.length > 0) throw invalidInput(descriptor, `missing required option: ${missing[0].name}`);
  for (const option of descriptor.options) {
    for (const value of values.get(option.name) ?? []) {
      if (option.values && !option.values.includes(value)) throw invalidInput(descriptor, option.invalidValue?.(value) ?? `${option.name} must be one of: ${option.values.join(", ")}`);
      option.validate?.(value);
    }
  }
  for (const relation of descriptor.exactlyOne ?? []) {
    if (relation.names.filter((name) => values.has(name) || booleans.has(name)).length !== 1) throw invalidInput(descriptor, relation.error);
  }
  for (const option of descriptor.options) {
    if (!values.has(option.name) && !booleans.has(option.name)) continue;
    if (option.requiresValue && toolValue({ values }, option.requiresValue.name) !== option.requiresValue.value) throw invalidInput(descriptor, option.requiresValue.error);
    for (const conflict of option.conflictsWith ?? []) if (values.has(conflict.name) || booleans.has(conflict.name)) throw invalidInput(descriptor, conflict.error);
  }
  return { help: false, values, booleans };
}

export function toolOption(descriptor, name) {
  const option = descriptor.options.find((candidate) => candidate.name === name);
  if (option === undefined) throw new Error(`${descriptor.id} has no option descriptor for ${name}`);
  return option;
}

export function toolValue(parsed, name) {
  return parsed.values.get(name)?.at(-1);
}

export function toolValues(parsed, name) {
  return parsed.values.get(name) ?? [];
}

function invalidInput(descriptor, message) {
  return new Error(descriptor.invalidInputShowsHelp ? renderToolHelp(descriptor) : message);
}

function validateNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
}

function validateTestPrefix(value) {
  if (value.startsWith("/") || value.split("/").includes("..") || value.includes("\\")) throw new Error(`--prefix must be a POSIX repository-relative path; received ${JSON.stringify(value)}`);
}

function validateTestFile(value) {
  if (value.startsWith("/") || value.split("/").includes("..") || value.includes("\\") || !/\.(?:test|spec)\.(?:mjs|js|ts)$/u.test(value)) throw new Error(`--file must be a POSIX repository-relative test file; received ${JSON.stringify(value)}`);
}
