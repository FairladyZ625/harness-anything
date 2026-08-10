export function computeRunMetrics({ scenario, subjectActions, invocations, durableState }) {
  const applicable = scenario.commandOpportunities.filter((opportunity) => opportunity.applicable);
  const attemptsByOpportunity = new Map(applicable.map((opportunity) => [opportunity.id, []]));
  for (const invocation of invocations) {
    if (attemptsByOpportunity.has(invocation.opportunityId)) attemptsByOpportunity.get(invocation.opportunityId).push(invocation);
  }

  const invoked = applicable.filter((opportunity) => attemptsByOpportunity.get(opportunity.id).length > 0);
  const firstCorrect = invoked.filter((opportunity) => invocationSucceeded(attemptsByOpportunity.get(opportunity.id)[0]));
  const eventuallySucceeded = invoked.filter((opportunity) => attemptsByOpportunity.get(opportunity.id).some(invocationSucceeded));
  const verificationChecks = durableState.checks ?? [];
  const verificationPassed = verificationChecks.filter((check) => check.status === "passed");
  const bypasses = subjectActions.actions.flatMap(classifyBypass);
  const eligiblePathActions = invocations.filter((invocation) => ["primary", "alternative"].includes(invocation.route));
  const alternativeActions = eligiblePathActions.filter((invocation) => invocation.route === "alternative");

  return {
    scenario: {
      id: scenario.id,
      prompt: scenario.prompt,
      theoreticalMinimumCommands: scenario.theoreticalMinimumCommands,
      commandOpportunities: scenario.commandOpportunities.map((opportunity) => ({
        ...opportunity,
        invoked: attemptsByOpportunity.get(opportunity.id)?.length > 0
      })),
      verificationIds: scenario.verificationIds
    },
    metrics: {
      commandOpportunitySet: { applicable: applicable.length, invoked: invoked.length },
      invocationRate: rate(invoked.length, applicable.length),
      firstAttemptCorrectRate: rate(firstCorrect.length, invoked.length),
      postInvocationSuccessRate: rate(eventuallySucceeded.length, invoked.length),
      driverVerificationCompletionRate: rate(verificationPassed.length, scenario.verificationIds.length),
      helpCalls: invocations.filter((invocation) => invocation.argv.includes("--help")).length,
      capabilitiesCalls: invocations.filter((invocation) => invocation.argv.includes("capabilities")).length,
      recoverySteps: invoked.reduce((total, opportunity) => total + recoverySteps(attemptsByOpportunity.get(opportunity.id)), 0),
      totalSubjectCommands: invocations.length,
      theoreticalMinimumCommands: scenario.theoreticalMinimumCommands,
      commandInflationRate: invocations.length / scenario.theoreticalMinimumCommands,
      bypassRate: {
        events: bypasses.length,
        totalActions: subjectActions.actions.length,
        rate: bypasses.length / subjectActions.actions.length,
        categories: [...new Set(bypasses)].sort()
      },
      alternativePathShare: {
        alternativeActions: alternativeActions.length,
        eligiblePathActions: eligiblePathActions.length,
        rate: alternativeActions.length / eligiblePathActions.length
      }
    }
  };
}

export function detectContamination({ subjectActions, evaluatorPaths, evaluatorFilesPresentInWorkspace }) {
  const normalizedEvaluators = evaluatorPaths.map((candidate) => normalize(candidate));
  const accessed = new Set();
  for (const action of subjectActions.actions) {
    const actionText = normalize([action.path, action.command, ...(action.argv ?? [])].filter(Boolean).join(" "));
    for (const evaluator of normalizedEvaluators) {
      if (actionText.includes(evaluator)) accessed.add(evaluator);
    }
  }
  const reasons = [];
  if (evaluatorFilesPresentInWorkspace) reasons.push("evaluator-files-present-in-subject-workspace");
  if (accessed.size > 0) reasons.push("subject-accessed-evaluator-file");
  return {
    status: reasons.length > 0 ? "contaminated" : "clean",
    detectorVersion: "action-log-path-scan/v1",
    actionLogComplete: subjectActions.actionLogComplete === true,
    evaluatorFilesPresentInWorkspace,
    accessedEvaluatorFiles: [...accessed].sort(),
    reasons
  };
}

function rate(numerator, denominator) {
  if (denominator < 1) throw new Error("rate denominator must be positive; scenario declarations may not fabricate an empty denominator");
  return { numerator, denominator, value: numerator / denominator };
}

function invocationSucceeded(invocation) {
  return invocation.exitCode === 0 && (!invocation.receiptExpected || invocation.receiptParsed);
}

function recoverySteps(attempts) {
  if (attempts.length < 2 || invocationSucceeded(attempts[0])) return 0;
  const successIndex = attempts.findIndex(invocationSucceeded);
  return successIndex < 0 ? attempts.length - 1 : successIndex;
}

function classifyBypass(action) {
  if (action.kind === "cli") return [];
  const text = `${action.kind} ${action.command ?? ""} ${action.path ?? ""}`;
  const categories = [];
  if (/\b(?:sqlite3|\.sqlite|projections\.sqlite)\b/iu.test(text)) categories.push("sqlite-direct");
  if (/\bgit\s+(?:add|commit|reset|checkout|show|log|status|diff)\b/iu.test(text) || action.kind === "git") categories.push("git-direct");
  if (["read", "write", "edit", "file"].includes(action.kind) || /\b(?:cat|sed|head|tail|cp|mv|perl)\b/iu.test(text)) categories.push("filesystem-direct");
  return categories.length > 0 ? categories : ["non-cli-alternative"];
}

function normalize(value) {
  return String(value).replaceAll("\\", "/").toLowerCase();
}
