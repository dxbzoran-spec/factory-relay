import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveFacts } from '../src/facts.js';
import { nextStep } from '../src/routes.js';

const cfg = { reworkLimit: 3, productionUrl: 'https://sapic-site.pages.dev' };
const PREVIEW = 'https://abc123.sapic-site.pages.dev';

function step({ status = 'To Do', category = 'new', labels = ['factory'], comments = [], links = [] }) {
  const issue = {
    key: 'SCRUM-99',
    fields: { summary: 's', status: { name: status, statusCategory: { key: category } }, labels, issuelinks: links },
  };
  const c = comments.map((body, i) => ({ body, created: `2026-11-03T10:0${i}:00Z` }));
  return nextStep(deriveFacts(issue, c, cfg), cfg);
}
const bug = (done = false) => ({
  inwardIssue: { key: 'SCRUM-100', fields: { issuetype: { name: 'Bug' }, status: { statusCategory: { key: done ? 'done' : 'new' } } } },
});

test('1 new story → QA orchestrator headless', () => {
  const s = step({});
  assert.equal(s.id, '1-qa-orchestrate');
  assert.match(s.job.prompt, /qa-orchestrator SCRUM-99 --headless/);
});

test('1 hitl-0 is passed on to the orchestrator', () => {
  assert.match(step({ labels: ['factory', 'hitl-0'] }).job.prompt, /hitl-0/);
});

test('2 waits for a human reply, agent comments do not count', () => {
  const s = step({ labels: ['factory', 'awaiting-approval'], comments: ['[factory] approval prompt …', 'QA PASSED on x'] });
  assert.equal(s.id, '2-wait-approval');
});

test('2 human reply → resume', () => {
  const s = step({ labels: ['factory', 'awaiting-approval'], comments: ['[factory] approval prompt …', 'approve'] });
  assert.equal(s.id, '2-qa-resume');
});

test('3 contract ready → DEV', () => {
  assert.equal(step({ labels: ['factory', 'contract-ready'] }).id, '3-dev-implement');
});

test('in progress without a bug → idle (DEV working)', () => {
  assert.equal(step({ status: 'In Progress', category: 'indeterminate', labels: ['factory', 'contract-ready'] }).id, 'idle');
});

test('4 handoff → QA verify on the test URL', () => {
  const s = step({ status: 'In Review', category: 'indeterminate', labels: ['factory', 'contract-ready'], comments: [`Test URL: ${PREVIEW}`] });
  assert.equal(s.id, '4-qa-verify');
  assert.match(s.job.prompt, new RegExp(PREVIEW));
});

test('4 an old verdict does not count for a new test URL', () => {
  const s = step({
    status: 'In Review', category: 'indeterminate', labels: ['factory'],
    comments: ['QA PASSED on https://old.sapic-site.pages.dev', `Test URL: ${PREVIEW}`],
  });
  assert.equal(s.id, '4-qa-verify');
});

test('5 open bug while in progress → rework, then stuck at the limit', () => {
  const base = { status: 'In Progress', category: 'indeterminate', labels: ['factory'], links: [bug()] };
  assert.equal(step(base).id, '5-dev-rework');
  const r = '[factory] rework round';
  const s = step({ ...base, comments: [r, r, r] });
  assert.equal(s.id, '5-stuck-rework');
  assert.equal(s.markStuck, true);
});

test('5 a closed bug does not trigger rework', () => {
  assert.equal(step({ status: 'In Progress', category: 'indeterminate', labels: ['factory'], links: [bug(true)] }).id, 'idle');
});

test('6 QA PASSED on the preview → merge', () => {
  const s = step({ status: 'In Review', category: 'indeterminate', labels: ['factory'], comments: [`Test URL: ${PREVIEW}`, `QA PASSED on ${PREVIEW} (CI …)`] });
  assert.equal(s.id, '6-merge');
});

test('7 staged: hitl 1 waits for "release", hitl 0 promotes', () => {
  assert.equal(step({ status: 'In Review', labels: ['factory', 'staged'] }).id, '7-wait-release');
  assert.equal(step({ status: 'In Review', labels: ['factory', 'staged'], comments: ['release'] }).id, '7-promote');
  assert.equal(step({ status: 'In Review', labels: ['factory', 'staged', 'hitl-0'] }).id, '7-promote');
});

test('8 released → QA release, done → none, stuck → wait', () => {
  assert.equal(step({ status: 'In Review', labels: ['factory', 'staged', 'released'] }).id, '8-qa-release');
  assert.equal(step({ status: 'Done', category: 'done' }).id, 'done');
  assert.equal(step({ labels: ['factory', 'factory-stuck'] }).id, 'stuck');
});
