#!/usr/bin/env node
// factory-relay: polls Jira and decides the next step of every factory story.
//   node relay.js --dry-run [--all]   print the next step per story, run nothing
//   node relay.js --once              one poll, run due jobs, exit      (build step 2)
//   node relay.js                     poll forever                       (build step 2)
// --all includes stories without the opt-in label (dry-run only, for checking the routes).

import { readFileSync, existsSync } from 'node:fs';
import { createJira } from './src/jira.js';
import { deriveFacts } from './src/facts.js';
import { nextStep } from './src/routes.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const all = args.has('--all');

if (existsSync(new URL('./.env', import.meta.url))) process.loadEnvFile(new URL('./.env', import.meta.url));
const cfg = JSON.parse(readFileSync(new URL('./relay.config.json', import.meta.url), 'utf8'));
const jira = createJira({ site: cfg.jira.site, email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN });

if (!dryRun) {
  console.error('Only --dry-run exists yet; the runner comes in build step 2.');
  process.exit(2);
}
if (all && !dryRun) {
  console.error('--all is for --dry-run only.');
  process.exit(2);
}

// Bugs are never driven directly: the relay reaches them through the story's links (step 5).
const jql = `project = ${cfg.jira.project} AND issuetype != Bug${all ? '' : ` AND labels = ${cfg.jira.optInLabel}`} ORDER BY key ASC`;

async function poll() {
  const issues = await jira.search(jql);
  if (!issues.length) {
    console.log(`No stories match: ${jql}`);
    return;
  }
  for (const issue of issues) {
    const facts = deriveFacts(issue, await jira.comments(issue.key), cfg);
    const step = nextStep(facts, cfg);
    const what = step.kind === 'run'
      ? `RUN ${step.job.agent}: ${step.job.prompt || step.job.action}`
      : `${step.kind.toUpperCase()}: ${step.reason}`;
    console.log(`${facts.key.padEnd(9)} ${facts.status.padEnd(12)} hitl ${facts.hitl}  [${step.id}] ${what}`);
  }
}

poll().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
