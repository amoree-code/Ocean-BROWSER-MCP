#!/usr/bin/env node
// Runs the pinned chrome-devtools-mcp (an exact dependency with none of its own) in this
// process, attached to the owner's running browser. In-process, so a client that kills this
// server leaves no orphan behind. CrUX lookups and usage statistics are on by default upstream;
// the flags turn them off so page URLs stay on this machine.
//
// Two changes to upstream's output and defaults, made here so upstream stays unforked:
// - Page tools (new_page, navigate_page, select_page, …) answer with every open tab: ~2K tokens
//   per call with 25 tabs, and every private tab shown to the agent. Their responses keep only
//   the selected tab and say how many others are open; `list_pages` still lists all of them.
//   OCEAN_BROWSER_ALL_TABS=1 turns this off.
// - Navigation waits 30 s by default instead of 10 s (slow consoles timed out); a call's own
//   `timeout` still wins.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const UPSTREAM = 'chrome-devtools-mcp';
export const FLAGS = ['--autoConnect', '--no-usage-statistics', '--no-performance-crux'];
export const NAVIGATION_TIMEOUT_MS = 30_000;
// The one tool whose job is listing tabs; every other tool's tab list is trimmed.
export const FULL_LIST_TOOLS = new Set(['list_pages']);

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

// The `## Pages` block of a tool's text: the selected tab, then one line for the rest.
export function trimPagesText(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('## Pages');
  if (start < 0) return text;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('## ')) end += 1;
  const pages = lines.slice(start + 1, end).filter((line) => /^\d+: /.test(line));
  const selected = pages.filter((line) => line.includes(' [selected]'));
  const others = pages.length - selected.length;
  if (others === 0) return text;
  const kept = [
    '## Pages',
    ...selected,
    `(${others} other tab${others === 1 ? '' : 's'} open — list_pages shows them)`,
  ];
  return [...lines.slice(0, start), ...kept, ...lines.slice(end)].join('\n');
}

// One tools/call result: the text and the structured page list, trimmed alike.
export function trimToolResult(result) {
  if (!result || typeof result !== 'object') return result;
  const next = { ...result };
  if (Array.isArray(result.content))
    next.content = result.content.map((item) =>
      item?.type === 'text' && typeof item.text === 'string'
        ? { ...item, text: trimPagesText(item.text) }
        : item,
    );
  const structured = result.structuredContent;
  if (structured && Array.isArray(structured.pages)) {
    const selected = structured.pages.filter((page) => page?.selected);
    const omitted = structured.pages.length - selected.length;
    if (omitted > 0)
      next.structuredContent = { ...structured, pages: selected, otherPagesOmitted: omitted };
  }
  return next;
}

// Newline-delimited JSON-RPC, as the stdio transport speaks it. Requests are only read, to learn
// which tool each call id names; the responses of page tools are trimmed.
export function createTabTrimmer() {
  const tools = new Map();
  let inbound = '';
  let outbound = '';
  const parse = (line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  };
  return {
    observeInput(chunk) {
      inbound += chunk.toString();
      const lines = inbound.split('\n');
      inbound = lines.pop() ?? '';
      for (const line of lines) {
        const message = parse(line);
        if (message?.method === 'tools/call' && message.id !== undefined)
          tools.set(message.id, message.params?.name);
      }
    },
    // The complete lines ready to write; a partial line waits for the rest of it.
    transformOutput(chunk) {
      outbound += chunk.toString();
      const lines = outbound.split('\n');
      outbound = lines.pop() ?? '';
      return lines
        .map((line) => {
          const message = parse(line);
          if (!message || message.id === undefined || !tools.has(message.id)) return line;
          const tool = tools.get(message.id);
          tools.delete(message.id);
          if (FULL_LIST_TOOLS.has(tool) || !message.result) return line;
          return JSON.stringify({ ...message, result: trimToolResult(message.result) });
        })
        .map((line) => `${line}\n`)
        .join('');
    },
  };
}

function installTabTrimmer() {
  const trimmer = createTabTrimmer();
  // Peek at stdin through emit: a 'data' listener added here would start the stream flowing
  // before upstream's transport listens, and the first request could be lost.
  const emit = process.stdin.emit.bind(process.stdin);
  process.stdin.emit = (event, ...args) => {
    if (event === 'data') trimmer.observeInput(args[0]);
    return emit(event, ...args);
  };
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => {
    const done = typeof encoding === 'function' ? encoding : callback;
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    const ready = trimmer.transformOutput(text);
    if (!ready) {
      done?.();
      return true;
    }
    return write(ready, done);
  };
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

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(require('node:fs').realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const { file } = upstreamBin();
  await raiseNavigationTimeout(file);
  if (process.env.OCEAN_BROWSER_ALL_TABS !== '1') installTabTrimmer();
  process.argv = [process.argv[0], file, ...upstreamArgv(process.argv.slice(2))];
  await import(pathToFileURL(file).href);
}
