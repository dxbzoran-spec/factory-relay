# factory-relay – agent rules

Local watcher that moves a Jira story through QA (testforge-mvp) and DEV (sapic-site) without a human
typing commands. It is the ONLY place that knows both sides; QA and DEV still talk only through Jira.
Plan: `C:\Users\lenov\.claude\plans\unite-testforge-mvp-qa-and-cheerful-flute.md` (state machine, build order).

## Layout
- `relay.config.json` – Jira site/project, opt-in label, agent working dirs, timeouts. No logic.
- `src/routes.js` – the flow (Jira state → next step). The only file that knows the order of steps.
- `src/facts.js` – pure: issue + comments → facts. Agent comments are recognised by text markers
  (`[factory] …`, `QA PASSED/FAILED on`, `Test URL:`), because every comment is posted with the same token.
- `src/jira.js` – Jira REST (API token from `.env`). The relay writes only markers: labels, `[factory] …` comments.
- `src/runner.js` – runs `claude.exe -p` headless in the agent's cwd; log per step in `logs/<KEY>/`, lock in `locks/`.
- `relay.js` – CLI and poll loop. One agent step at a time. After a step, Jira must show progress, else `factory-stuck`.

## Agents
| Agent | cwd | Entry skills |
|---|---|---|
| qa | `D:\Projects\testforge-mvp` | `/qa-verify-story` (step 4); later `/qa-orchestrator --headless/--resume`, `/qa-release` |
| dev | `D:\Projects\dev-nest` (+ `--add-dir D:\Projects\sapic-site`) | `/dev-implement --headless [--rework]` (steps 3, 5) |

Permissions are passed per agent from `relay.config.json` (`--allowedTools` / `--disallowedTools`): headless runs did
not apply the agent repos' project settings. Headless Claude here has a PowerShell tool and no Bash tool, so every
shell rule exists in both forms. QA may not push or use `gh`; DEV may not merge, start workflows, force-push or push `main`.

## Enabled steps
`enabledSteps` in the config. Today: 3, 4, 5 (DEV build → QA verify → rework). For step 3 the story needs the labels
`factory` + `contract-ready` (set by hand after `/qa-orchestrator`, until steps 1–2 are built).

## Rules
- All flow state lives in Jira (status, labels, comments). The relay keeps no state besides per-story locks.
- Opt-in: only stories labelled `factory`. `hitl-0` = no human gates; default is hitl 1 (approve plan + release).
- Change the flow in `routes.js` and add a case to `test/routes.test.js`; `npm test` must stay green.
- Never hardcode a host outside `relay.config.json`.

## Commands
`npm test` · `node relay.js --dry-run` (factory stories) · `node relay.js --dry-run --all` (every story, for checking routes)
