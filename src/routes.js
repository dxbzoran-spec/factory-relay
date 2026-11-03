// The flow. The ONLY file that knows which Jira state leads to which step.
// First matching route wins. A route returns either a job to run (agent 'qa' | 'dev', or 'ops')
// or a wait/none reason. Moving to GitHub later replaces the trigger and the runner, not this file.

const hitlNote = (f) => (f.hitl === 0 ? ' Label hitl-0 is set: no human gates.' : '');

export const routes = [
  { id: 'stuck', when: (f) => f.stuck, wait: () => 'label factory-stuck: fix by hand, then remove the label' },
  { id: 'done', when: (f) => f.done, none: () => 'Done' },

  // 8 – production verification after the promote
  {
    id: '8-qa-release', when: (f) => f.released,
    run: (f) => ({ agent: 'qaRelease', prompt: `/qa-release ${f.key}` }),
  },

  // 7 – release gate, then promote
  {
    id: '7-wait-release', when: (f) => f.staged && f.hitl === 1 && !f.releaseApproved,
    wait: () => 'staging green; comment "release" on the story to promote to production',
  },
  {
    id: '7-promote', when: (f) => f.staged,
    run: (f) => ({ agent: 'ops', action: 'promote', key: f.key }),
  },

  // 6 – QA passed on the preview: merge, wait for staging
  {
    id: '6-merge', when: (f) => f.verdict === 'PASSED' && !f.onProduction,
    run: (f) => ({ agent: 'ops', action: 'merge', key: f.key }),
  },

  // 5 – QA filed a Bug: DEV reworks on the same branch
  {
    id: '5-stuck-rework', when: (f, cfg) => f.openBugs.length > 0 && f.status === 'In Progress' && f.reworkRounds >= cfg.reworkLimit,
    wait: (f) => `rework limit reached (${f.reworkRounds}); relay will mark factory-stuck`,
    stuck: true,
  },
  {
    id: '5-dev-rework', when: (f) => f.openBugs.length > 0 && f.status === 'In Progress',
    run: (f) => ({ agent: 'dev', prompt: `/dev-implement ${f.key} --headless --rework (open bugs: ${f.openBugs.join(', ')})` }),
  },

  // 4 – DEV handed off: QA agent verifies on the test URL (a CI verdict alone does not count, see facts.js)
  {
    id: '4-qa-verify', when: (f) => f.status === 'In Review' && f.testUrl && f.verdict !== 'PASSED',
    run: (f) => ({ agent: 'qa', prompt: `/qa-verify-story ${f.key} ${f.testUrl}` }),
  },

  // 3 – contract agreed: DEV builds
  {
    id: '3-dev-implement', when: (f) => f.contractReady && f.status === 'To Do',
    run: (f) => ({ agent: 'dev', prompt: `/dev-implement ${f.key} --headless` }),
  },

  // 2 – approval reply in Jira: QA continues
  {
    id: '2-wait-approval', when: (f) => f.awaitingApproval && !f.approvalReply,
    wait: () => 'approval prompt posted; reply "approve" (or changes) as a Jira comment',
  },
  {
    id: '2-qa-resume', when: (f) => f.awaitingApproval,
    run: (f) => ({ agent: 'qa', prompt: `/qa-orchestrator ${f.key} --resume` }),
  },

  // 1 – new story: QA analyses it
  {
    id: '1-qa-orchestrate', when: (f) => f.status === 'To Do' && !f.contractReady,
    run: (f) => ({ agent: 'qa', prompt: `/qa-orchestrator ${f.key} --headless${hitlNote(f)}` }),
  },

  { id: 'idle', when: () => true, wait: (f) => `nothing to do in status "${f.status}" (an agent may be working on it)` },
];

export function nextStep(facts, cfg) {
  const r = routes.find((route) => route.when(facts, cfg));
  if (r.run) return { id: r.id, kind: 'run', job: r.run(facts, cfg) };
  if (r.none) return { id: r.id, kind: 'none', reason: r.none(facts) };
  return { id: r.id, kind: 'wait', reason: r.wait(facts, cfg), markStuck: Boolean(r.stuck) };
}
