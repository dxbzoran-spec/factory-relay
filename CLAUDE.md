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
| qa | `D:\Projects\testforge-mvp` | `/qa-orchestrator --headless --hitl=0\|1` (1), `--resume` (2), `/qa-verify-story` (4), `/qa-release` (8) |
| dev | `D:\Projects\dev-nest` (+ `--add-dir D:\Projects\sapic-site`) | `/dev-implement --headless [--rework]` (steps 3, 5) |

Sessions are lean: `mcpConfig` (+ `--strict-mcp-config`) loads only the agent's Jira/Playwright servers, and
`settingSources: project,local` skips user-level plugins, hooks and settings. That halves the start context
(41k → 22k tokens, 156 → 89 tools), which every turn rereads. The project skills stay available.

Permissions are passed per agent from `relay.config.json` (`--allowedTools` / `--disallowedTools`): headless runs did
not apply the agent repos' project settings. Headless Claude here has a PowerShell tool and no Bash tool, so every
shell rule exists in both forms. QA pushes testforge after every commit (so QA CI tests the same specs) but may not
force-push or use `gh`; DEV may not merge, start workflows, force-push or push `main`.

## Release steps (no agent, `src/ops.js`, `gh` with the active account)
- **6 merge**: PR `feature/<KEY>` checks green → `gh pr merge --merge --delete-branch` → wait for CI/CD on `main`
  (tests + staging deploy + smoke) → comment + label `staged`.
- **7 promote**: hitl 1 waits for a human comment starting with `release`; hitl 0 goes on. Then `promote.yml` on `main`
  (it refuses unless CI/CD for that commit is green), wait for it → comment + label `released`.
  Promote ships the whole of `main`: with one story in flight at a time that is just this story.
- **8**: the QA agent checks production, drops `@pending`, pushes testforge, posts QA PASSED, sets Done.

## Enabled steps
`enabledSteps` in the config. Today: all, 1–8. A new To Do story only needs the label `factory` (+ `hitl-0` for no
human gates). Run history: SCRUM-13 (steps 3–8, hitl 1, 2026-11-03), SCRUM-14 (steps 1–8, hitl-0, 22 min, no human).

## Open items (details: testforge `docs/PROGRESS.md`, "Pick up next")
- Applied 2026-11-03, not yet seen in a live run: hitl-0 falls back to the approval prompt when a story changes an
  earlier story's accepted behaviour or tests; QA pushes testforge after every step.
- Not exercised live: the hitl 1 approval reply (step 2), the fail → rework loop (step 5), stuck recovery.
- Model per agent (cost), running as a background service, move to GitHub.
- The relay runs in a terminal and stops with it; start it again with `node relay.js`.

## Rules
- All flow state lives in Jira (status, labels, comments). The relay keeps no state besides per-story locks.
- Opt-in: only stories labelled `factory`. `hitl-0` = no human gates; default is hitl 1 (approve plan + release).
- Change the flow in `routes.js` and add a case to `test/routes.test.js`; `npm test` must stay green.
- Never hardcode a host outside `relay.config.json`.

## Commands
`npm test` · `node relay.js --dry-run` (factory stories) · `node relay.js --dry-run --all` (every story, for checking routes)
