// Deterministic release steps (no agent, no tokens): merge after QA PASSED, promote after the release gate.
// Everything goes through the GitHub CLI with the active `gh` account. Each step returns
// { ok, summary, ...facts } and never throws for an expected failure (red CI, no PR), so the relay can mark it stuck.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const GH = process.platform === 'win32' ? 'gh.exe' : 'gh';
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function gh(args) {
  const { stdout } = await run(GH, args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}
const ghJson = async (args) => JSON.parse((await gh(args)) || 'null');

// Waits for the CI/CD push run of `sha` on main. Returns the finished run, or null on timeout.
async function waitForRun({ repo, workflow, sha, event, since, timeoutMinutes, log }) {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let announced = false;
  while (Date.now() < deadline) {
    const args = ['run', 'list', '-R', repo, '--workflow', workflow, '--limit', '10',
      '--json', 'databaseId,status,conclusion,url,headSha,createdAt,event'];
    const runs = (await ghJson(args)) || [];
    const match = runs.find((r) => (!sha || r.headSha === sha) && (!event || r.event === event)
      && (!since || new Date(r.createdAt).getTime() >= since));
    if (match && !announced) { log(`    · ${workflow} run ${match.url}`); announced = true; }
    if (match?.status === 'completed') return match;
    await sleep(20);
  }
  return null;
}

async function deploymentUrl(repo, environment, sha) {
  const deps = (await ghJson(['api', `repos/${repo}/deployments?environment=${environment}&sha=${sha}`])) || [];
  if (!deps.length) return null;
  const statuses = (await ghJson(['api', `repos/${repo}/deployments/${deps[0].id}/statuses`])) || [];
  return statuses.find((s) => s.state === 'success')?.environment_url || null;
}

// Step 6: merge feature/<KEY> once its PR checks are green, then wait for CI/CD (tests + staging) on main.
export async function merge({ key, product, timeoutMinutes, log }) {
  const { repo, ciWorkflow } = product;
  const head = `feature/${key}`;
  let [pr] = (await ghJson(['pr', 'list', '-R', repo, '--head', head, '--state', 'all', '--json', 'number,url,state,mergeable'])) || [];
  if (!pr) return { ok: false, summary: `no PR for ${head}` };

  if (pr.state === 'OPEN') {
    const checks = (await ghJson(['pr', 'checks', String(pr.number), '-R', repo, '--json', 'name,bucket'])) || [];
    const bad = checks.filter((c) => !['pass', 'skipping'].includes(c.bucket));
    if (bad.length) return { ok: false, summary: `PR #${pr.number} checks not green: ${bad.map((c) => `${c.name}=${c.bucket}`).join(', ')}` };
    if (pr.mergeable === 'CONFLICTING') return { ok: false, summary: `PR #${pr.number} has merge conflicts` };
    log(`    · merging PR #${pr.number}`);
    await gh(['pr', 'merge', String(pr.number), '-R', repo, '--merge', '--delete-branch']);
  } else if (pr.state !== 'MERGED') {
    return { ok: false, summary: `PR #${pr.number} is ${pr.state}` };
  }
  const sha = (await ghJson(['pr', 'view', String(pr.number), '-R', repo, '--json', 'mergeCommit'])).mergeCommit?.oid;
  if (!sha) return { ok: false, summary: `PR #${pr.number} merged but no merge commit found` };

  const ci = await waitForRun({ repo, workflow: ciWorkflow, sha, event: 'push', timeoutMinutes, log });
  if (!ci) return { ok: false, summary: `CI/CD for ${sha.slice(0, 7)} on main did not finish in ${timeoutMinutes} min` };
  if (ci.conclusion !== 'success') return { ok: false, summary: `CI/CD for ${sha.slice(0, 7)} on main: ${ci.conclusion} (${ci.url})` };

  const deployed = await deploymentUrl(repo, 'staging', sha);
  const stagingUrl = product.stagingUrl + (deployed ? ` (${deployed})` : '');
  return { ok: true, pr, sha, ciUrl: ci.url, stagingUrl,
    summary: `merged PR #${pr.number} (${sha.slice(0, 7)}); CI/CD on main green (${ci.url}), staging ${stagingUrl}` };
}

// Step 7: promote the current main to production (promote.yml refuses unless CI/CD for that commit is green).
export async function promote({ product, timeoutMinutes, log }) {
  const { repo, ciWorkflow, promoteWorkflow } = product;
  const sha = await gh(['api', `repos/${repo}/commits/main`, '--jq', '.sha']);
  const ci = await waitForRun({ repo, workflow: ciWorkflow, sha, event: 'push', timeoutMinutes, log });
  if (ci?.conclusion !== 'success') return { ok: false, summary: `CI/CD for main ${sha.slice(0, 7)} is not green (${ci?.conclusion || 'not finished'})` };

  const since = Date.now() - 5_000;
  log(`    · starting ${promoteWorkflow} on main @ ${sha.slice(0, 7)}`);
  await gh(['workflow', 'run', promoteWorkflow, '-R', repo, '--ref', 'main']);
  const pr = await waitForRun({ repo, workflow: promoteWorkflow, event: 'workflow_dispatch', since, timeoutMinutes, log });
  if (!pr) return { ok: false, summary: `${promoteWorkflow} did not finish in ${timeoutMinutes} min` };
  if (pr.conclusion !== 'success') return { ok: false, summary: `${promoteWorkflow}: ${pr.conclusion} (${pr.url}). Check production; roll back in Cloudflare if needed.` };
  return { ok: true, sha, runUrl: pr.url,
    summary: `promoted main ${sha.slice(0, 7)} to production ${product.productionUrl} (${pr.url})` };
}
