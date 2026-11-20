#!/usr/bin/env node
// Runs the pinned chrome-devtools-mcp (an exact dependency with none of its own) in this
// process, attached to the owner's running browser. In-process, so a client that kills this
// server leaves no orphan behind. Upstream stays unforked; the wrapper only sets flags, patches
// two upstream entry points and rewrites replies on the way out:
// - lib/config.mjs: privacy, security and token defaults, tool profiles, URL blocklist.
// - lib/filter.mjs: tab-list trim, snapshot diff, screenshot previews, usage log.
// - lib/cursor.mjs: visible pointer and "Ocean is driving" frame on the tab the agent uses.
// - lib/shared.mjs: one browser connection shared by every session (one "Allow" prompt), via
//   upstream's daemon; `ocean-browser-mcp status|stop` shows or stops it.
// - Navigation waits 30 s by default instead of 10 s; a call's own `timeout` still wins.
// Upstream's config-file discovery (~/.config/cd4a/config.json) is off: that file can change the
// browser binary and its flags, and an agent able to write it could take the setup over.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isOff, stateDir, UPSTREAM, upstreamArgv } from '../lib/config.mjs';
import { installCursor } from '../lib/cursor.mjs';
import { createResponseFilter } from '../lib/filter.mjs';
import {
  callShared,
  createCallSplitter,
  daemonArgv,
  ensureDaemon,
  idleMinutes,
  loadDaemonApi,
  ourSessions,
  sessionIdFor,
} from '../lib/shared.mjs';

export { blockedPatterns, FLAGS, PROFILES, profileName, stateDir, UPSTREAM, upstreamArgv } from '../lib/config.mjs';
export { hideDuringScreenshots, installCursor, overlayLabel, pageOverlay, patchScreenshots } from '../lib/cursor.mjs';
export {
  capSnapshotText,
  createResponseFilter,
  createTabTrimmer,
  dietSnapshotText,
  FULL_LIST_TOOLS,
  prunePreviews,
  rotateUsage,
  savePreview,
  snapshotMax,
  trimPagesText,
  trimToolResult,
} from '../lib/filter.mjs';

export {
  createCallSplitter,
  daemonArgv,
  idleMinutes,
  installIdleStop,
  SESSION_PREFIX,
  sessionIdFor,
} from '../lib/shared.mjs';

export const NAVIGATION_TIMEOUT_MS = 30_000;
export const NO_CONFIG_DISCOVERY_ENV = 'CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY';

const require = createRequire(import.meta.url);

export function upstreamBin() {
  const manifestFile = require.resolve(`${UPSTREAM}/package.json`);
  const { bin, version } = require(manifestFile);
  return { file: path.join(path.dirname(manifestFile), bin[UPSTREAM]), version };
}

// Upstream builds its one context through McpContext.create(logger, options) (index.js), and
// every page takes its navigation timeout from those options; unset there means 10 s.
export async function raiseNavigationTimeout(upstreamFile) {
  const contextFile = path.join(path.dirname(upstreamFile), '..', 'McpContext.js');
  const { McpContext } = await import(pathToFileURL(contextFile).href);
  const create = McpContext.create.bind(McpContext);
  McpContext.create = (logger, options = {}, ...rest) =>
    create(
      logger,
      { ...options, navigationTimeout: options.navigationTimeout ?? NAVIGATION_TIMEOUT_MS },
      ...rest,
    );
}

// The daemon side of shared mode: `call` runs one tool there. It throws `{ fallback: true }`
// only when the daemon cannot be started, so the session can run the call itself; a call that
// failed inside the daemon is reported, never run twice.
export async function sharedRouter(upstreamFile, upstreamVersion, argv, env = process.env) {
  const api = await loadDaemonApi(upstreamFile);
  const dargv = daemonArgv(argv);
  const { version } = require('../package.json');
  // Settings the daemon reads from its environment are part of its identity too, so changing
  // one starts a new daemon instead of reusing one started with the old value.
  const sessionId = sessionIdFor(dargv, {
    wrapper: version,
    upstream: upstreamVersion,
    cursor: !isOff(env.OCEAN_BROWSER_CURSOR),
    idle: idleMinutes(env),
  });
  const daemonScript = fileURLToPath(new URL('../daemon/daemon.js', import.meta.url));
  let starting;
  const ensure = async () => {
    if (api.isDaemonRunning(sessionId)) return;
    starting ??= ensureDaemon({ api, sessionId, daemonScript, argv: dargv, env, logDir: stateDir(env) }).finally(() => {
      starting = undefined;
    });
    try {
      await starting;
    } catch (error) {
      throw Object.assign(error, { fallback: true });
    }
  };
  return {
    sessionId,
    async call(name, args) {
      try {
        return await callShared({ api, sessionId, ensure }, name, args);
      } catch (error) {
        if (error?.fallback) throw error;
        return { content: [{ type: 'text', text: `The shared browser connection failed: ${error?.message ?? error}` }], isError: true };
      }
    },
  };
}

// Peek at stdin through emit: a 'data' listener added here would start the stream flowing
// before upstream's transport listens, and the first request could be lost. In shared mode,
// tools/call lines go to the daemon and their replies are written here; the rest reaches upstream.
function installResponseFilter(filter, router) {
  const emit = process.stdin.emit.bind(process.stdin);
  const split = createCallSplitter();
  process.stdin.emit = (event, ...args) => {
    if (event !== 'data') return emit(event, ...args);
    if (!router) {
      filter.observeInput(args[0]);
      return emit(event, ...args);
    }
    const { calls, rest } = split(args[0]);
    for (const { line, message } of calls) {
      filter.observeInput(`${line}\n`);
      router
        .call(message.params?.name, message.params?.arguments)
        .then((result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`))
        .catch(() => emit('data', Buffer.from(`${line}\n`)));
    }
    if (rest) {
      filter.observeInput(rest);
      emit('data', Buffer.from(rest));
    }
    return true;
  };
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => {
    const done = typeof encoding === 'function' ? encoding : callback;
    const ready = filter.transformOutput(chunk);
    if (!ready) {
      done?.();
      return true;
    }
    return write(ready, done);
  };
}

// `ocean-browser-mcp status` lists the running shared daemons; `stop` stops them (the browser
// stays open, it is only disconnected).
async function daemonCommand(action, upstreamFile) {
  const api = await loadDaemonApi(upstreamFile);
  const sessions = ourSessions(api);
  if (action === 'stop') {
    for (const id of sessions) await api.stopDaemon(id);
    console.log(sessions.length ? `Stopped ${sessions.length} shared browser connection(s).` : 'No shared browser connection is running.');
    return;
  }
  const rows = [];
  for (const id of sessions) {
    const reply = await api.sendCommand({ method: 'status' }, id, 2_000).catch(() => undefined);
    rows.push(reply?.success ? { session: id, ...JSON.parse(reply.result) } : { session: id, status: 'not answering' });
  }
  console.log(JSON.stringify(rows, null, 2));
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(require('node:fs').realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.env[NO_CONFIG_DISCOVERY_ENV] = '1';
  const { file, version } = upstreamBin();
  const action = process.argv[2];
  if (action === 'status' || action === 'stop') {
    await daemonCommand(action, file);
    process.exit(0);
  }
  const argv = upstreamArgv(process.argv.slice(2));
  const filter = createResponseFilter(process.env);
  await raiseNavigationTimeout(file);
  // In shared mode the daemon draws the cursor; this one only runs a call the daemon could not.
  await installCursor(file, () => filter.state.client, { overlay: !isOff(process.env.OCEAN_BROWSER_CURSOR) });
  const router = isOff(process.env.OCEAN_BROWSER_SHARED) ? undefined : await sharedRouter(file, version, argv);
  installResponseFilter(filter, router);
  process.argv = [process.argv[0], file, ...argv];
  await import(pathToFileURL(file).href);
}
