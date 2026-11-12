#!/usr/bin/env node
// Runs the pinned chrome-devtools-mcp (an exact dependency with none of its own) in this
// process, attached to the owner's running Chrome. In-process, so a client that kills this server
// leaves no orphan behind. CrUX lookups and usage statistics are on by default upstream; the flags
// turn them off so page URLs stay on this machine.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const UPSTREAM = 'chrome-devtools-mcp';
export const FLAGS = ['--autoConnect', '--no-usage-statistics', '--no-performance-crux'];

const require = createRequire(import.meta.url);

export function upstreamBin() {
  const manifestFile = require.resolve(`${UPSTREAM}/package.json`);
  const { bin, version } = require(manifestFile);
  return { file: path.join(path.dirname(manifestFile), bin[UPSTREAM]), version };
}

// Flags first, so an explicit argument from the caller can still override one.
export function upstreamArgv(extra = []) {
  return [...FLAGS, ...extra];
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(require('node:fs').realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const { file } = upstreamBin();
  process.argv = [process.argv[0], file, ...upstreamArgv(process.argv.slice(2))];
  await import(pathToFileURL(file).href);
}
