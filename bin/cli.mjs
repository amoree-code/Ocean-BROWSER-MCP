#!/usr/bin/env node
// Starts the pinned upstream chrome-devtools-mcp attached to the owner's running Chrome.
// Flags keep page URLs on the machine: CrUX lookups and usage statistics are on by default upstream.
import { spawn } from 'node:child_process';

export const UPSTREAM = 'chrome-devtools-mcp@1.12.0';
export const FLAGS = ['--autoConnect', '--no-usage-statistics', '--no-performance-crux'];

export function launchPlan(extra = []) {
  return { command: 'npx', args: ['-y', UPSTREAM, ...FLAGS, ...extra] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { command, args } = launchPlan(process.argv.slice(2));
  const child = spawn(command, args, { stdio: 'inherit' });
  child.once('error', (error) => {
    console.error(`ocean-browser-mcp: cannot start ${command}: ${error.message}`);
    process.exit(1);
  });
  child.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
