export function parseGateWorkflow(text) {
  const jobs = new Map();
  let inJobs = false;
  let current = null;
  let multilineRunIndent = null;
  for (const line of text.split(/\r?\n/u)) {
    if (multilineRunIndent !== null) {
      const indent = /^\s*/u.exec(line)?.[0].length ?? 0;
      if (line.trim() && indent > multilineRunIndent) {
        current.runCommands.push(line.trim());
        continue;
      }
      multilineRunIndent = null;
    }
    if (/^jobs:\s*$/u.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const jobMatch = /^  ([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (jobMatch) {
      current = { id: jobMatch[1], ifExpressions: [], runCommands: [], nodeVersions: [] };
      jobs.set(current.id, current);
      continue;
    }
    if (!current) continue;
    const ifMatch = /^\s+if:\s*(.+?)\s*$/u.exec(line);
    if (ifMatch) current.ifExpressions.push(unquoteYamlScalar(ifMatch[1]));
    const runMatch = /^\s+(?:-\s*)?run:\s*(.+?)\s*$/u.exec(line);
    if (runMatch) {
      const command = unquoteYamlScalar(runMatch[1]);
      if (command === "|" || command === ">") multilineRunIndent = /^\s*/u.exec(line)?.[0].length ?? 0;
      else current.runCommands.push(command);
    }
    const nodeVersionMatch = /^\s+node-version:\s*(.+?)\s*$/u.exec(line);
    if (nodeVersionMatch) current.nodeVersions.push(...extractNumbers(unquoteYamlScalar(nodeVersionMatch[1])));
  }
  for (const job of jobs.values()) {
    job.isPullRequestJob = job.ifExpressions.some((expression) =>
      expression.includes("github.event_name == 'pull_request'"),
    );
    job.isNonPullRequestJob = job.ifExpressions.some((expression) =>
      expression.includes("github.event_name != 'pull_request'"),
    );
  }
  return jobs;
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractNumbers(value) {
  return [...String(value).matchAll(/\d+/gu)].map((match) => Number(match[0]));
}
