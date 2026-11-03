#!/usr/bin/env node
// factory-relay: polls Jira and starts the next step of every factory story.
//   node relay.js                     poll forever, run due steps (one agent at a time)
//   node relay.js --once              one poll; if a step is due, run it, then exit
//   node relay.js --dry-run [--all]   print the next step per story, run nothing
// --all includes stories without the opt-in label (dry-run only, for checking the routes).

import { readFileSync, existsSync } from 'node:fs';
import { createJira } from './src/jira.js';
import { deriveFacts } from './src/facts.js';
import { nextStep } from './src/routes.js';
import { runAgent, staleLocks, clearLock } from './src/runner.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const once = args.has('--once');
const all = args.has('--all');
if (all && !dryRun) {
  console.error('--all is for --dry-run only.');
  process.exit(2);
}

const envFile = new URL('./.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const cfg = JSON.parse(readFileSync(new URL('./relay.config.json', import.meta.url), 'utf8'));
const jira = createJira({ site: cfg.jira.site, email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN });

// Bugs are never driven directly: the relay reaches them through the story's links (step 5).
const jql = `project = ${cfg.jira.project} AND issuetype != Bug${all ? '' : ` AND labels = ${cfg.jira.optInLabel}`} ORDER BY key ASC`;

const time = () => new Date().toTimeString().slice(0, 8);
const say = (msg) => console.log(`${time()} ${msg}`);
const lastLine = new Map(); // key → last printed state, so a waiting story is printed once, not every poll
let running = null; // { key, stepId, promise }

async function factsFor(issue) {
  return deriveFacts(issue, await jira.comments(issue.key), cfg);
}

async function markStuck(key, reason, logPath) {
  say(`${key} STUCK: ${reason}`);
  await jira.addLabel(key, 'factory-stuck');
  await jira.comment(key, `[factory] relay stopped: ${reason}${logPath ? `\nLog: ${logPath}` : ''}\nFix it, then remove the label factory-stuck.`);
}

// A lock left by a killed or crashed relay means a step was cut off half-way: never re-run it blindly.
async function recoverInterruptedSteps() {
  for (const lock of staleLocks()) {
    if (dryRun) {
      say(`${lock.key} has a lock from an interrupted step ${lock.stepId} (log ${lock.logPath})`);
      continue;
    }
    await markStuck(lock.key, `step ${lock.stepId} was interrupted (relay stopped while it ran)`, lock.logPath);
    clearLock(lock.key);
  }
}

async function start(facts, step) {
  const { key } = facts;
  const { job } = step;
  if (step.id === '5-dev-rework') {
    await jira.comment(key, `[factory] rework round ${facts.reworkRounds + 1} of ${cfg.reworkLimit}: ${facts.openBugs.join(', ')}`);
  }
  say(`${key} [${step.id}] ${job.agent.toUpperCase()} started: ${job.prompt}`);
  const result = await runAgent({
    key, stepId: step.id, agent: cfg.agents[job.agent], prompt: job.prompt,
    timeoutMinutes: cfg.stepTimeoutMinutes, log: (l) => console.log(l),
  });
  const took = result.minutes !== undefined ? ` in ${result.minutes} min` : '';
  const cost = result.costUsd !== undefined ? `, $${result.costUsd.toFixed(2)}` : '';
  if (!result.ok) {
    const why = result.timedOut ? `timed out after ${cfg.stepTimeoutMinutes} min` : `agent ended with an error (exit ${result.exitCode})`;
    return markStuck(key, `step ${step.id} ${why}. ${result.summary.slice(0, 300)}`, result.logPath);
  }
  // Success = Jira moved on. Same step again means the agent stopped without its marker (e.g. "blocked").
  const [issue] = await jira.search(`key = ${key}`);
  const after = nextStep(await factsFor(issue), cfg);
  if (after.id === step.id) {
    return markStuck(key, `step ${step.id} finished${took} but Jira shows no progress. Agent said: ${result.summary.slice(0, 300)}`, result.logPath);
  }
  say(`${key} [${step.id}] done${took}${cost} → next: [${after.id}]`);
}

async function poll() {
  const issues = await jira.search(jql);
  if (!issues.length) {
    if (lastLine.get('*') !== 'none') say(`no stories match: ${jql}`);
    lastLine.set('*', 'none');
    return;
  }
  lastLine.delete('*');
  for (const issue of issues) {
    if (running?.key === issue.key) continue;
    const facts = await factsFor(issue);
    const step = nextStep(facts, cfg);
    const enabled = step.kind === 'run' && cfg.enabledSteps.includes(step.id);

    if (dryRun) {
      const what = step.kind === 'run'
        ? `RUN ${step.job.agent}: ${step.job.prompt || step.job.action}${enabled ? '' : '   (step not enabled yet)'}`
        : `${step.kind.toUpperCase()}: ${step.reason}`;
      console.log(`${facts.key.padEnd(9)} ${String(facts.status).padEnd(12)} hitl ${facts.hitl}  [${step.id}] ${what}`);
      continue;
    }

    if (step.markStuck && cfg.enabledSteps.includes(step.id)) {
      await markStuck(facts.key, step.reason);
      continue;
    }
    if (enabled && !running) {
      running = { key: facts.key, stepId: step.id };
      running.promise = start(facts, step)
        .catch((err) => say(`${facts.key} relay error: ${err.message}`))
        .finally(() => { running = null; lastLine.delete(facts.key); });
      continue;
    }
    const line = step.kind === 'run'
      ? (enabled ? `[${step.id}] due, waits for ${running.key}` : `[${step.id}] would run ${step.job.agent}: step not enabled yet`)
      : `[${step.id}] ${step.reason}`;
    if (lastLine.get(facts.key) !== line) say(`${facts.key} ${line}`);
    lastLine.set(facts.key, line);
  }
}

async function main() {
  await recoverInterruptedSteps();
  if (dryRun) return poll();
  say(`relay up: ${jql}; steps ${cfg.enabledSteps.join(', ')}; poll ${cfg.pollSeconds}s`);
  for (;;) {
    try {
      await poll();
    } catch (err) {
      say(`poll failed: ${err.message}`);
    }
    if (once) {
      await running?.promise;
      return;
    }
    await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
