// Runs one agent step: `claude -p "<prompt>"` in the agent's working dir, headless.
// Streams the session to logs/<KEY>/<step>-<time>.jsonl and prints the tools it uses, so the flow is visible live.
// A lock file per story marks a running step; a lock left behind by a crash or kill is found on the next start.

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, createWriteStream, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const LOCKS = join(ROOT, 'locks');
const LOGS = join(ROOT, 'logs');

export function staleLocks() {
  if (!existsSync(LOCKS)) return [];
  return readdirSync(LOCKS).map((f) => JSON.parse(readFileSync(join(LOCKS, f), 'utf8')));
}
export const clearLock = (key) => rmSync(join(LOCKS, `${key}.json`), { force: true });

function killTree(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

export function runAgent({ key, stepId, agent, prompt, timeoutMinutes, log = console.log }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(join(LOGS, key), { recursive: true });
  mkdirSync(LOCKS, { recursive: true });
  const logPath = join(LOGS, key, `${stepId}-${stamp}.jsonl`);
  const out = createWriteStream(logPath);

  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
  for (const dir of agent.addDirs || []) args.push('--add-dir', dir);
  // Permissions come from relay.config.json, not from the agent repos' settings (headless runs did not pick those up).
  if (agent.allow?.length) args.push('--allowedTools', ...agent.allow);
  if (agent.deny?.length) args.push('--disallowedTools', ...agent.deny);

  return new Promise((resolve) => {
    const command = agent.command || (process.platform === 'win32' ? 'claude.exe' : 'claude');
    const child = spawn(command, args, { cwd: agent.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(join(LOCKS, `${key}.json`), JSON.stringify({ key, stepId, pid: child.pid, started: stamp, logPath }));

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMinutes * 60_000);
    let result = null;
    let buf = '';

    child.stdout.on('data', (chunk) => {
      out.write(chunk);
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'assistant') {
          for (const c of ev.message?.content || []) {
            if (c.type === 'tool_use') log(`    · ${c.name}${toolHint(c.input)}`);
          }
        } else if (ev.type === 'result') {
          result = ev;
        }
      }
    });
    child.stderr.on('data', (chunk) => out.write(chunk));

    child.on('close', (code) => {
      clearTimeout(timer);
      out.end();
      clearLock(key);
      resolve({
        ok: code === 0 && !timedOut && result && !result.is_error,
        exitCode: code,
        timedOut,
        logPath,
        summary: (result?.result || '').trim(),
        costUsd: result?.total_cost_usd,
        minutes: result ? Math.round(result.duration_ms / 60_000) : undefined,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      out.end(String(err));
      clearLock(key);
      resolve({ ok: false, exitCode: null, timedOut: false, logPath, summary: `could not start claude: ${err.message}` });
    });
  });
}

function toolHint(input = {}) {
  const v = input.command || input.skill || input.file_path || input.url || input.issueIdOrKey || '';
  const s = String(v).replace(/\s+/g, ' ');
  return s ? `  ${s.length > 90 ? s.slice(0, 87) + '…' : s}` : '';
}
