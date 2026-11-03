// Turns a Jira issue + its comments into the plain facts the routes decide on.
// Pure function: no I/O, so it is unit-tested in test/.

// Comments written by agents or the relay. All of them are posted with Zoran's token,
// so text markers (not the author) tell an agent comment from a human one.
const AGENT_COMMENT = [/^\s*\[factory\]/i, /^\s*QA (PASSED|FAILED)\b/, /Test URL:/];
const isAgentComment = (body) => AGENT_COMMENT.some((re) => re.test(body));

const APPROVAL_PROMPT = /^\s*\[factory\] approval prompt/i;
const RELEASE = /^\s*release\b/i;
// Only the QA agent's verdict gates the flow. QA CI also posts "QA PASSED on <url> (CI …)" for every
// preview, but it does not verify the contract locators, so it is informational here.
const VERDICT = /^\s*QA (PASSED|FAILED) on (\S+)(?![\s\S]*\(CI\b)/;
const TEST_URL = /Test URL:\s*(\S+)/;

function latest(comments, re) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const m = comments[i].body.match(re);
    if (m) return { match: m, created: comments[i].created, index: i };
  }
  return null;
}

export function deriveFacts(issue, comments, { productionUrl } = {}) {
  const f = issue.fields;
  const labels = f.labels || [];
  const has = (l) => labels.includes(l);

  const prompt = latest(comments, APPROVAL_PROMPT);
  const reply = prompt
    ? comments.slice(prompt.index + 1).find((c) => !isAgentComment(c.body))
    : null;

  const testUrl = latest(comments, TEST_URL);
  const verdict = latest(comments, VERDICT);
  const verdictIsCurrent = Boolean(testUrl && verdict && verdict.index > testUrl.index);

  // Only Bugs that block the story (QA links them "Bug blocks story"); "Relates" links are ignored.
  const openBugs = (f.issuelinks || [])
    .filter((l) => l.type?.name === 'Blocks')
    .map((l) => l.inwardIssue)
    .filter((i) => i && i.fields.issuetype?.name === 'Bug' && i.fields.status?.statusCategory?.key !== 'done')
    .map((i) => i.key);

  const reworkRounds = comments.filter((c) => /^\s*\[factory\] rework round/i.test(c.body)).length;

  return {
    key: issue.key,
    summary: f.summary,
    status: f.status?.name,
    done: f.status?.statusCategory?.key === 'done',
    hitl: has('hitl-0') ? 0 : 1,
    stuck: has('factory-stuck'),
    awaitingApproval: has('awaiting-approval'),
    contractReady: has('contract-ready'),
    staged: has('staged'),
    released: has('released'),
    approvalReply: reply ? reply.body.trim() : null,
    releaseApproved: comments.some((c) => RELEASE.test(c.body)),
    testUrl: testUrl ? testUrl.match[1] : null,
    verdict: verdictIsCurrent ? verdict.match[1] : null, // PASSED | FAILED for the current test URL
    verdictUrl: verdictIsCurrent ? verdict.match[2] : null,
    onProduction: Boolean(verdictIsCurrent && productionUrl && verdict.match[2].startsWith(productionUrl)),
    openBugs,
    reworkRounds,
  };
}
