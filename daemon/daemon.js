#!/usr/bin/env node
// The shared browser daemon (see lib/shared.mjs): upstream's daemon/daemon.js with the
// wrapper's patches applied first, so the one shared connection keeps the 30 s navigation, the
// visible cursor and the idle stop. Started by bin/cli.mjs, never by hand. It lives at
// daemon/daemon.js because upstream's isDaemonRunning only trusts a process whose command line
// matches /daemon/daemon.js.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isOff } from '../lib/config.mjs';
import { installCursor } from '../lib/cursor.mjs';
import { idleMinutes, installIdleStop } from '../lib/shared.mjs';
import { NO_CONFIG_DISCOVERY_ENV, raiseNavigationTimeout, upstreamBin } from '../bin/cli.mjs';

process.env[NO_CONFIG_DISCOVERY_ENV] = '1';
const { file } = upstreamBin();
await raiseNavigationTimeout(file);
await installCursor(file, undefined, { overlay: !isOff(process.env.OCEAN_BROWSER_CURSOR) });
await installIdleStop(file, idleMinutes(process.env));
const daemonFile = path.join(path.dirname(file), '..', 'daemon', 'daemon.js');
process.argv = [process.argv[0], daemonFile, ...process.argv.slice(2)];
await import(pathToFileURL(daemonFile).href);
