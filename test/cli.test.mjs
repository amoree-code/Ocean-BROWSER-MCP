import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  createTabTrimmer,
  FLAGS,
  NAVIGATION_TIMEOUT_MS,
  raiseNavigationTimeout,
  trimPagesText,
  trimToolResult,
  UPSTREAM,
  upstreamArgv,
  upstreamBin,
} from '../bin/cli.mjs';

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const pkg = read('package.json');
const capability = read('ocean.capability.json');

test('upstream is an exact pin and its bin exists', () => {
  assert.match(pkg.dependencies[UPSTREAM], /^\d+\.\d+\.\d+$/);
  const { file, version } = upstreamBin();
  assert.equal(version, pkg.dependencies[UPSTREAM]);
  assert.ok(existsSync(file), file);
});

test('privacy and attach flags come first, caller arguments after', () => {
  assert.deepEqual(FLAGS, ['--autoConnect', '--no-usage-statistics', '--no-performance-crux']);
  assert.deepEqual(upstreamArgv(['--x']), [...FLAGS, '--x']);
});

test('capability points at this package, version and bin', () => {
  assert.equal(capability.kind, 'mcp');
  assert.equal(capability.server.name, capability.name);
  const [item] = capability.server.packages;
  assert.equal(item.registryType, 'npm');
  assert.equal(item.identifier, pkg.name);
  assert.equal(item.version, pkg.version);
  assert.equal(item.transport.type, 'stdio');
  assert.ok(pkg.bin[pkg.name]);
  // The market launches npm packages through npx, from the npm registry.
  assert.deepEqual(capability.permissions.exec, ['npx']);
  assert.ok(capability.permissions.network.includes('registry.npmjs.org'));
});

test('published files include everything the bin and market need', () => {
  for (const file of ['bin/cli.mjs', 'ocean.capability.json', 'README.md'])
    assert.ok(pkg.files.includes(file), file);
});

// Initialize and list tools over stdio; neither needs Chrome to be running.
test('serves MCP over stdio with the browser tools', { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, [new URL('../bin/cli.mjs', import.meta.url).pathname], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const replies = new Map();
  let buffer = '';
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines)
        if (line.startsWith('{')) {
          const reply = JSON.parse(line);
          replies.set(reply.id, reply);
        }
      if (replies.has(2)) resolve();
    });
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  try {
    await done;
  } finally {
    child.kill();
  }
  assert.equal(replies.get(1).result.serverInfo.name, 'chrome_devtools');
  const tools = replies.get(2).result.tools.map((tool) => tool.name);
  for (const name of ['list_pages', 'navigate_page', 'click', 'fill', 'upload_file', 'take_screenshot', 'list_console_messages', 'list_network_requests'])
    assert.ok(tools.includes(name), name);
});

// T-316: page tools answered with every open tab (~2K tokens a call with 25 tabs).
const PAGES = ['# navigate_page response', 'Navigated.', '## Pages', '1: Inbox (https://mail.example/)', '2: Docs (https://docs.example/) [selected]', '3: Shop (https://shop.example/)', '## Console', 'none'].join('\n');

test('a page tool keeps the selected tab and counts the others', () => {
  assert.equal(
    trimPagesText(PAGES),
    ['# navigate_page response', 'Navigated.', '## Pages', '2: Docs (https://docs.example/) [selected]', '(2 other tabs open — list_pages shows them)', '## Console', 'none'].join('\n'),
  );
  assert.equal(trimPagesText('no pages block'), 'no pages block');
  const one = ['## Pages', '1: Only (https://a.example/) [selected]'].join('\n');
  assert.equal(trimPagesText(one), one);
  const result = trimToolResult({
    content: [{ type: 'text', text: PAGES }],
    structuredContent: { pages: [{ id: 1 }, { id: 2, selected: true }, { id: 3 }] },
  });
  assert.deepEqual(result.structuredContent, { pages: [{ id: 2, selected: true }], otherPagesOmitted: 2 });
  assert.doesNotMatch(result.content[0].text, /mail\.example|shop\.example/);
});

test('the stream trimmer leaves list_pages whole and joins split lines', () => {
  const trimmer = createTabTrimmer();
  const call = (id, name) => `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })}\n`;
  const reply = (id) => JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: PAGES }] } });
  const both = call(1, 'navigate_page') + call(2, 'list_pages');
  trimmer.observeInput(both.slice(0, 30));
  trimmer.observeInput(both.slice(30));
  const first = reply(1);
  assert.equal(trimmer.transformOutput(first.slice(0, 40)), '');
  const navigated = JSON.parse(trimmer.transformOutput(`${first.slice(40)}\n`));
  assert.match(navigated.result.content[0].text, /2 other tabs open/);
  const listed = JSON.parse(trimmer.transformOutput(`${reply(2)}\n`));
  assert.equal(listed.result.content[0].text, PAGES);
  // A message that is not a tool reply passes through as it was.
  assert.equal(trimmer.transformOutput('{"jsonrpc":"2.0","method":"notifications/x"}\n'), '{"jsonrpc":"2.0","method":"notifications/x"}\n');
});

test('upstream contexts are created with a 30 s navigation timeout unless one is given', async () => {
  const { file } = upstreamBin();
  const { McpContext } = await import(new URL(`file://${path.join(path.dirname(file), '..', 'McpContext.js')}`).href);
  const original = McpContext.create;
  const seen = [];
  McpContext.create = (_logger, options) => seen.push(options);
  try {
    await raiseNavigationTimeout(file);
    McpContext.create(null, { experimentalDevtools: false });
    McpContext.create(null, { navigationTimeout: 5000 });
  } finally {
    McpContext.create = original;
  }
  assert.equal(NAVIGATION_TIMEOUT_MS, 30_000);
  assert.deepEqual(seen, [{ experimentalDevtools: false, navigationTimeout: 30_000 }, { navigationTimeout: 5000 }]);
});
