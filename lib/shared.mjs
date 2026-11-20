// One browser connection shared by every client session (OCEAN_BROWSER_SHARED, on by default).
// The browser asks the owner to allow each new DevTools connection; without this, every client
// session opened a new one and raised that prompt again. Now the first session starts a
// background daemon (upstream's own `daemon/daemon.js`, run through this package's daemon/daemon.js so the
// wrapper's patches apply) and later sessions reuse it. Each session still answers initialize
// and tools/list itself; only tools/call goes to the daemon. The daemon disconnects (the browser
// stays open) after OCEAN_BROWSER_IDLE_MIN minutes without a call (default 8 hours).
//
// Upstream's daemon keeps its socket and pid file in a 0700 directory it checks for ownership,
// symlinks and permissions; a session id names one daemon per (wrapper version, arguments).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

// Hex, as upstream requires of a session id; marks the daemons this package started.
export const SESSION_PREFIX = '0cea0';
// The browser asks to allow every new connection, so the shared one lasts a working day.
export const DEFAULT_IDLE_MIN = 8 * 60;
const READY_TIMEOUT_MS = 15_000;
// Lighthouse and traces can run for minutes; the daemon's own tool timeouts still apply.
const CALL_TIMEOUT_MS = 10 * 60_000;

export function sessionIdFor(argv, versions) {
  const digest = createHash('sha256').update(JSON.stringify({ argv, versions })).digest('hex');
  return `${SESSION_PREFIX}-${digest.slice(0, 12)}`;
}

// OCEAN_BROWSER_IDLE_MIN: minutes without a call before the daemon disconnects; 0 or `never`
// keeps it until `ocean-browser-mcp stop`, a reboot, or the browser's debugging switch.
export function idleMinutes(env = process.env) {
  const raw = (env.OCEAN_BROWSER_IDLE_MIN ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'never') return Infinity;
  const minutes = Number(raw);
  return raw && Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_IDLE_MIN;
}

// The daemon has no client to negotiate MCP roots with, so file tools (upload_file, a screenshot
// saved to a path) would be limited to the OS temp directory; give it the home and temp dirs.
export function daemonArgv(argv, home = os.homedir(), tmp = os.tmpdir()) {
  return [...argv, '--filesystemRoot', home, '--filesystemRoot', tmp];
}

export async function loadDaemonApi(upstreamFile) {
  const dir = path.join(path.dirname(upstreamFile), '..', 'daemon');
  const [client, utils] = await Promise.all([
    import(pathToFileURL(path.join(dir, 'client.js')).href),
    import(pathToFileURL(path.join(dir, 'utils.js')).href),
  ]);
  return { ...client, ...utils };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isReady(api, sessionId) {
  if (!api.isDaemonRunning(sessionId)) return false;
  try {
    return (await api.sendCommand({ method: 'status' }, sessionId, 1_000)).success === true;
  } catch {
    return false;
  }
}

// Starts the daemon unless it already answers. Two sessions racing both spawn one; upstream's
// daemon exits at once when another holds the pid file, so one survives and both wait for it.
// The daemon's output goes to `<logDir>/daemon-<session>.log` (rewritten at each start), so a
// daemon that dies leaves a reason behind.
export async function ensureDaemon({ api, sessionId, daemonScript, argv, env = process.env, logDir }) {
  if (await isReady(api, sessionId)) return;
  let log = 'ignore';
  if (logDir)
    try {
      mkdirSync(logDir, { recursive: true });
      log = openSync(path.join(logDir, `daemon-${sessionId}.log`), 'w');
    } catch {
      log = 'ignore';
    }
  const child = spawn(process.execPath, [daemonScript, ...argv], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...env, CHROME_DEVTOOLS_MCP_SESSION_ID: sessionId },
  });
  child.unref();
  if (typeof log === 'number') closeSync(log);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isReady(api, sessionId)) return;
    await pause(100);
  }
  throw new Error('the shared browser daemon did not start');
}

// Returns a JSON-RPC result for one tools/call, run by the daemon.
export async function callShared({ api, sessionId, ensure }, name, args) {
  await ensure();
  const reply = await api.sendCommand({ method: 'invoke_tool', tool: name, args: args ?? {} }, sessionId, CALL_TIMEOUT_MS);
  if (!reply.success) throw new Error(reply.error ?? 'the shared browser daemon failed');
  return JSON.parse(reply.result);
}

// Session ids of this package's daemons that have a runtime directory now.
export function ourSessions(api, tmpRoot = os.platform() === 'win32' ? os.tmpdir() : '/tmp') {
  const base = process.env.XDG_RUNTIME_DIR || tmpRoot;
  const pattern = new RegExp(`^chrome-devtools-mcp-(${SESSION_PREFIX}-[0-9a-f]{12})`);
  let names = [];
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  return [...new Set(names.map((name) => name.match(pattern)?.[1]).filter(Boolean))].filter((id) =>
    api.isDaemonRunning(id),
  );
}

// Splits stdin into the tools/call lines (sent to the daemon) and the rest (left to upstream).
// A StringDecoder keeps a multi-byte character split across two chunks whole (Arabic text in a
// fill call arrived as U+FFFD without it).
export function createCallSplitter() {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return (chunk) => {
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    const calls = [];
    const rest = [];
    for (const line of lines) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        message = undefined;
      }
      if (message?.method === 'tools/call' && message.id !== undefined) calls.push({ line, message });
      else rest.push(line);
    }
    return { calls, rest: rest.length ? `${rest.join('\n')}\n` : '' };
  };
}

// Patches upstream's McpServer.callTool (the daemon's only way in) to note each call, and stops
// the daemon after `minutes` without one. SIGTERM runs upstream's cleanup: disconnect, not close.
export async function installIdleStop(upstreamFile, minutes, { now = () => Date.now(), stop = () => process.kill(process.pid, 'SIGTERM') } = {}) {
  const indexFile = path.join(path.dirname(upstreamFile), '..', 'index.js');
  const { McpServer } = await import(pathToFileURL(indexFile).href);
  let last = now();
  let running = 0;
  const callTool = McpServer.prototype.callTool;
  McpServer.prototype.callTool = async function patchedCallTool(...args) {
    running += 1;
    last = now();
    try {
      return await callTool.apply(this, args);
    } finally {
      running -= 1;
      last = now();
    }
  };
  const check = () => {
    if (running === 0 && now() - last >= minutes * 60_000) stop();
  };
  if (Number.isFinite(minutes)) setInterval(check, Math.min(60_000, minutes * 60_000)).unref();
  return { check, McpServer };
}
