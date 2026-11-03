# factory-relay – agent rules

Local watcher that moves a Jira story through QA (testforge-mvp) and DEV (sapic-site) without a human
typing commands. It is the ONLY place that knows both sides; QA and DEV still talk only through Jira.
Plan: `C:\Users\lenov\.claude\plans\unite-testforge-mvp-qa-and-cheerful-flute.md` (state machine, build order).

## Layout
- `relay.config.json` – Jira site/project, opt-in label, agent working dirs, timeouts. No logic.
- `src/routes.js` – the flow (Jira state → next step). The only file that knows the order of steps.
- `src/facts.js` – pure: issue + comments → facts. Agent comments are recognised by text markers
  (`[factory] …`, `QA PASSED/FAILED on`, `Test URL:`), because every comment is posted with the same token.
- `src/jira.js` – Jira REST (API token from `.env`).
- `relay.js` – CLI and poll loop.

## Rules
- All flow state lives in Jira (status, labels, comments). The relay keeps no state besides per-story locks.
- Opt-in: only stories labelled `factory`. `hitl-0` = no human gates; default is hitl 1 (approve plan + release).
- Change the flow in `routes.js` and add a case to `test/routes.test.js`; `npm test` must stay green.
- Never hardcode a host outside `relay.config.json`.

## Commands
`npm test` · `node relay.js --dry-run` (factory stories) · `node relay.js --dry-run --all` (every story, for checking routes)
