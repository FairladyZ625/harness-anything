#!/usr/bin/env node

const plan = {
  schema: "coldstart-bench-subject-actions/v1",
  adapter: "scripted-json/v1",
  actionLogComplete: true,
  actions: [
    {
      id: "action-001",
      kind: "cli",
      argv: ["--help"],
      opportunityId: "discover-help",
      route: "primary",
      receiptExpected: true
    },
    {
      id: "action-002",
      kind: "cli",
      argv: ["capabilities"],
      opportunityId: "discover-capabilities",
      route: "alternative",
      receiptExpected: true
    },
    {
      id: "action-003",
      kind: "cli",
      argv: [
        "task",
        "create",
        "--title",
        "Cold-start scripted task",
        "--vertical",
        "software/coding",
        "--preset",
        "standard-task"
      ],
      opportunityId: "task-create",
      route: "primary",
      receiptExpected: true
    }
  ]
};

process.stdout.write(`${JSON.stringify(plan)}\n`);
