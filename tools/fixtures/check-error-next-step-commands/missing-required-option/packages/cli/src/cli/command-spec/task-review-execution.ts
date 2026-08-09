export const taskReviewExecutionCommandSpec = {
  kind: "task-review-execution",
  usage: "task review-execution <id> --verdict <verdict> --findings <text> --rationale <text>",
  options: [
    { flag: "--verdict <verdict>" },
    { flag: "--findings <text>" },
    { flag: "--rationale <text>" }
  ]
};
