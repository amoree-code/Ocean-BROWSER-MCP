import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import {
  capSnapshotText,
  snapshotMax,
  createCallSplitter,
  daemonArgv,
  idleMinutes,
  installIdleStop,
  SESSION_PREFIX,
  sessionIdFor,
  blockedPatterns,
  createResponseFilter,
  createTabTrimmer,
  dietSnapshotText,
  FLAGS,
  hideDuringScreenshots,
  installCursor,
  patchScreenshots,
  overlayLabel,
  PROFILES,
  profileName,
  prunePreviews,
  rotateUsage,
  savePreview,
  stateDir,
  NAVIGATION_TIMEOUT_MS,
  raiseNavigationTimeout,
  trimPagesText,
  trimToolResult,
  UPSTREAM,
  upstreamArgv,
  upstreamBin,
} from '../bin/cli.mjs';

// Tests never write the owner's usage log.
const QUIET = { OCEAN_BROWSER_USAGE: '0', OCEAN_BROWSER_PREVIEW: '0' };
const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const pkg = read('package.json');
const capability = read('ocean.capability.json');

test('upstream is an exact pin and its bin exists', () => {
  assert.match(pkg.dependencies[UPSTREAM], /^\d+\.\d+\.\d+$/);
  const { file, version } = upstreamBin();
  assert.equal(version, pkg.dependencies[UPSTREAM]);
  assert.ok(existsSync(file), file);
});

test('privacy, security and token flags come first, caller arguments after', () => {
  for (const flag of ['--autoConnect', '--no-usage-statistics', '--no-performance-crux', '--redactNetworkHeaders', '--no-file-navigations', '--screenshotFormat=webp'])
    assert.ok(FLAGS.includes(flag), flag);
  assert.deepEqual(upstreamArgv(['--x'], {}), [...FLAGS, ...PROFILES.standard.flags, '--x']);
  assert.deepEqual(upstreamArgv([], { OCEAN_BROWSER_PROFILE: 'slim' }), [...FLAGS, '--slim']);
  assert.deepEqual(upstreamArgv([], { OCEAN_BROWSER_BLOCKED: '*://*.bank.example/*, https://accounts.google.com/*' }).slice(-4), ['--blockedUrlPattern', '*://*.bank.example/*', '--blockedUrlPattern', 'https://accounts.google.com/*']);
  assert.deepEqual(blockedPatterns({ OCEAN_BROWSER_BLOCKED: 'a\n\n b ,' }), ['a', 'b']);
  assert.equal(profileName({ OCEAN_BROWSER_PROFILE: 'LEAN' }), 'lean');
  assert.equal(profileName({ OCEAN_BROWSER_PROFILE: 'nonsense' }), 'standard');
  assert.equal(stateDir({ OCEAN_BROWSER_STATE_DIR: '/x' }), '/x');
});

// Upstream parses every flag the wrapper passes (an unknown or renamed flag fails here).
test('upstream accepts the flags of every profile', async () => {
  const { file } = upstreamBin();
  const { ConfigParser } = await import(new URL(`file://${path.join(path.dirname(file), '..', 'config', 'ConfigParser.js')}`).href);
  for (const profile of Object.keys(PROFILES)) {
    const argv = ['node', 'x', ...upstreamArgv([], { OCEAN_BROWSER_PROFILE: profile, OCEAN_BROWSER_BLOCKED: '*://*.bank.example/*' })];
    const resolved = new ConfigParser(pkg.dependencies[UPSTREAM], argv, { CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: '1' }, false).parseConfig().resolved;
    assert.equal(resolved.autoConnect, true);
    assert.equal(resolved.redactNetworkHeaders, true);
    assert.equal(resolved.fileNavigations, false);
    assert.equal(resolved.screenshotFormat, 'webp');
    assert.deepEqual(resolved.blockedUrlPattern, ['*://*.bank.example/*']);
  }
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
  for (const file of ['bin/cli.mjs', 'daemon/daemon.js', 'lib/*.mjs', 'ocean.capability.json', 'README.md'])
    assert.ok(pkg.files.includes(file), file);
});

// Initialize and list tools over stdio; neither needs Chrome to be running.
test('serves MCP over stdio with the browser tools', { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, [new URL('../bin/cli.mjs', import.meta.url).pathname], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ...QUIET },
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
  for (const name of ['list_pages', 'navigate_page', 'click', 'fill', 'upload_file', 'take_screenshot', 'list_console_messages', 'list_network_requests', 'lighthouse_audit', 'emulate'])
    assert.ok(tools.includes(name), name);
  // The standard profile hides these.
  for (const name of ['take_heapsnapshot', 'set_logpoints', 'screencast_start'])
    assert.ok(!tools.includes(name), name);
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
  const trimmer = createTabTrimmer(QUIET);
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

// A snapshot with a long, unchanging navigation and one line that changes.
const NAV = Array.from({ length: 30 }, (_, i) => `  uid=1_${i + 2} link "Nav ${i}"`);
const snapshotReply = (status) => ['# wait_for response', 'Element found.', '## Latest page snapshot', 'uid=1_0 RootWebArea "Console"', ...NAV, `  uid=1_99 StaticText "${status}"`, '## Console', 'none'].join('\n');

test('an attached snapshot shows only what changed since the last one of that page', () => {
  const first = dietSnapshotText(snapshotReply('Loading'), undefined);
  assert.equal(first.text, snapshotReply('Loading'));
  const second = dietSnapshotText(snapshotReply('Saved'), new Set(first.body));
  assert.match(second.text, /## Latest page snapshot \(changes only\)/);
  assert.match(second.text, /31 unchanged lines left out/);
  assert.match(second.text, /uid=1_99 StaticText "Saved"/);
  assert.doesNotMatch(second.text, /Nav 5/);
  assert.match(second.text, /## Console\nnone$/);
  // Too little to save, or mostly changed: the whole snapshot.
  const small = ['## Latest page snapshot', 'uid=1_0 RootWebArea', '  uid=1_1 button "A"'].join('\n');
  assert.equal(dietSnapshotText(small, new Set(['uid=1_0 RootWebArea'])).text, small);
});

test('the filter diffs wait_for snapshots per page and never take_snapshot', () => {
  const filter = createResponseFilter(QUIET);
  const call = (id, name, args) => filter.observeInput(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  const reply = (id, text) => JSON.parse(filter.transformOutput(`${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })}\n`)).result.content[0].text;
  call(1, 'take_snapshot', { pageId: 2 });
  assert.equal(reply(1, snapshotReply('Loading')), snapshotReply('Loading'));
  call(2, 'wait_for', { pageId: 2 });
  assert.match(reply(2, snapshotReply('Saved')), /changes only/);
  call(3, 'wait_for', { pageId: 3 });
  assert.doesNotMatch(reply(3, snapshotReply('Saved')), /changes only/);
  call(4, 'take_snapshot', { pageId: 2 });
  assert.equal(reply(4, snapshotReply('Done')), snapshotReply('Done'));
  const full = createResponseFilter({ ...QUIET, OCEAN_BROWSER_FULL_SNAPSHOT: '1' });
  full.observeInput(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'take_snapshot', arguments: {} } })}\n`);
  full.transformOutput(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: snapshotReply('a') }] } })}\n`);
  full.observeInput(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wait_for', arguments: {} } })}\n`);
  assert.doesNotMatch(full.transformOutput(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: snapshotReply('b') }] } })}\n`), /changes only/);
});

test('tools/list drops the tools the profile hides', () => {
  const tools = [{ name: 'click' }, { name: 'set_logpoints' }, { name: 'drag' }];
  const listed = (env) => {
    const filter = createResponseFilter({ ...QUIET, ...env });
    filter.observeInput('{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n');
    return JSON.parse(filter.transformOutput(`${JSON.stringify({ jsonrpc: '2.0', id: 7, result: { tools } })}\n`)).result.tools.map((tool) => tool.name);
  };
  assert.deepEqual(listed({}), ['click', 'drag']);
  assert.deepEqual(listed({ OCEAN_BROWSER_PROFILE: 'lean' }), ['click']);
  assert.deepEqual(listed({ OCEAN_BROWSER_PROFILE: 'full' }), ['click', 'set_logpoints', 'drag']);
});

test('a screenshot is also saved as a preview file, and each call is logged without URLs', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ocean-browser-test-'));
  const png = Buffer.from('iVBORw0KGgo=', 'base64');
  const saved = savePreview({ content: [{ type: 'text', text: 'Took a screenshot.' }, { type: 'image', mimeType: 'image/webp', data: png.toString('base64') }] }, dir, new Date('2026-11-20T10:11:12.345Z'));
  const file = path.join(dir, 'shots', '2026-11-20', '10-11-12-345.webp');
  assert.equal(saved.content.at(-1).text, `Preview: ${file}`);
  assert.deepEqual(readFileSync(file), png);
  assert.deepEqual(savePreview({ content: [{ type: 'text', text: 'x' }] }, dir).content.length, 1);

  let clock = 1000;
  const filter = createResponseFilter({ OCEAN_BROWSER_STATE_DIR: dir }, { now: () => clock });
  filter.observeInput(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-code' } } })}\n`);
  filter.observeInput(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'take_screenshot', arguments: { pageId: 1 } } })}\n`);
  clock = 1250;
  const reply = JSON.parse(filter.transformOutput(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'https://secret.example/ shot' }, { type: 'image', mimeType: 'image/webp', data: png.toString('base64') }] } })}\n`));
  assert.match(reply.result.content.at(-1).text, /^Preview: .*\.webp$/);
  assert.equal(filter.state.client, 'claude-code');
  const [entry] = readFileSync(path.join(dir, 'usage.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entry.tool, 'take_screenshot');
  assert.equal(entry.client, 'claude-code');
  assert.equal(entry.profile, 'standard');
  assert.equal(entry.images, 1);
  assert.equal(entry.ms, 250);
  assert.doesNotMatch(JSON.stringify(entry), /secret\.example/);
  assert.ok(existsSync(reply.result.content.at(-1).text.slice('Preview: '.length)));
});

test('the cursor overlay goes only on tabs a tool acts on, installed once per page', async () => {
  const { file } = upstreamBin();
  const { McpPage } = await import(new URL(`file://${path.join(path.dirname(file), '..', 'McpPage.js')}`).href);
  const original = McpPage.prototype.init;
  const calls = [];
  McpPage.prototype.init = async function stub() {};
  try {
    await installCursor(file, () => 'claude-code');
    const page = {
      evaluateOnNewDocument: async (fn, label) => calls.push(['new', label]),
      evaluate: async (fn, label) => calls.push(['now', label]),
      screenshot: async () => 'image',
    };
    const mcpPage = Object.create(McpPage.prototype, { pptrPage: { get: () => page } });
    await mcpPage.init({ emulateFocus: false }); // tab discovery: nothing
    assert.deepEqual(calls, []);
    await mcpPage.init({ emulateFocus: true });
    await mcpPage.init({ emulateFocus: true });
    assert.deepEqual(calls, [['now', 'Ocean · claude-code'], ['new', 'Ocean · claude-code'], ['now', 'Ocean · claude-code']]);
    calls.length = 0;
    assert.equal(await page.screenshot(), 'image'); // hidden for the capture, shown after
    assert.equal(calls.length, 2);
  } finally {
    McpPage.prototype.init = original;
  }
  assert.equal(overlayLabel(undefined), 'Ocean');
});

test('shared mode: one daemon per wrapper version and arguments, with file roots', () => {
  const id = sessionIdFor(['--autoConnect'], { wrapper: '0.3.0', upstream: '1.13.0' });
  assert.match(id, new RegExp(`^${SESSION_PREFIX}-[0-9a-f]{12}$`));
  assert.equal(id, sessionIdFor(['--autoConnect'], { wrapper: '0.3.0', upstream: '1.13.0' }));
  assert.notEqual(id, sessionIdFor(['--autoConnect'], { wrapper: '0.3.1', upstream: '1.13.0' }));
  assert.notEqual(id, sessionIdFor(['--autoConnect', '--userDataDir', '/brave'], { wrapper: '0.3.0', upstream: '1.13.0' }));
  assert.deepEqual(daemonArgv(['--x'], '/home', '/tmp'), ['--x', '--filesystemRoot', '/home', '--filesystemRoot', '/tmp']);
  assert.equal(idleMinutes({}), 480);
  assert.equal(idleMinutes({ OCEAN_BROWSER_IDLE_MIN: '5' }), 5);
  assert.equal(idleMinutes({ OCEAN_BROWSER_IDLE_MIN: '-1' }), 480);
  assert.equal(idleMinutes({ OCEAN_BROWSER_IDLE_MIN: '0' }), Infinity);
  assert.equal(idleMinutes({ OCEAN_BROWSER_IDLE_MIN: 'never' }), Infinity);
});

test('shared mode sends only tools/call lines to the daemon, across split chunks', () => {
  const split = createCallSplitter();
  const init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';
  const call = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_pages","arguments":{}}}';
  const note = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
  const all = `${init}\n${call}\n${note}\n`;
  const first = split(all.slice(0, 70));
  assert.deepEqual(first, { calls: [], rest: `${init}\n` });
  const second = split(all.slice(70));
  assert.deepEqual(second.calls.map((each) => each.message.id), [2]);
  assert.equal(second.calls[0].line, call);
  assert.equal(second.rest, `${note}\n`);
});

test('the daemon stops itself after the idle time, never during a call', async () => {
  const { file } = upstreamBin();
  const { McpServer } = await import(new URL(`file://${path.join(path.dirname(file), '..', 'index.js')}`).href);
  const original = McpServer.prototype.callTool;
  let clock = 0;
  let stopped = 0;
  let release;
  McpServer.prototype.callTool = () => new Promise((resolve) => { release = resolve; });
  try {
    const { check } = await installIdleStop(file, 1, { now: () => clock, stop: () => { stopped += 1; } });
    clock = 59_000; check();
    assert.equal(stopped, 0);
    const running = McpServer.prototype.callTool.call({}, 'list_pages');
    clock = 200_000; check();
    assert.equal(stopped, 0); // a call is running
    release('done');
    assert.equal(await running, 'done');
    clock = 259_000; check();
    assert.equal(stopped, 0);
    clock = 260_001; check();
    assert.equal(stopped, 1);
  } finally {
    McpServer.prototype.callTool = original;
  }
});

// Arabic in a fill call, split inside a 2-byte character by the pipe.
const ARABIC = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'fill', arguments: { pageId: 1, uid: '1_2', value: 'مرحبا بغداد' } } });
const splitInsideChar = (line) => {
  const bytes = Buffer.from(`${line}\n`);
  const at = bytes.indexOf(Buffer.from('مرحبا')) + 1;
  return [bytes.subarray(0, at), bytes.subarray(at)];
};

test('a multi-byte character split across stdin chunks reaches the daemon whole', () => {
  const split = createCallSplitter();
  const [a, b] = splitInsideChar(ARABIC);
  assert.deepEqual(split(a), { calls: [], rest: '' });
  assert.equal(split(b).calls[0].message.params.arguments.value, 'مرحبا بغداد');
  const filter = createResponseFilter(QUIET);
  filter.observeInput(a);
  filter.observeInput(b);
  const reply = JSON.stringify({ jsonrpc: '2.0', id: 9, result: { content: [{ type: 'text', text: 'تم ✓' }] } });
  const [c, d] = [Buffer.from(`${reply}\n`).subarray(0, 60), Buffer.from(`${reply}\n`).subarray(60)];
  assert.equal(filter.transformOutput(c) + filter.transformOutput(d), `${reply}\n`);
});

test('a diff names the elements that left the page', () => {
  const before = snapshotReply('Loading');
  const after = before.replace('  uid=1_99 StaticText "Loading"', '  uid=1_100 StaticText "Done"');
  const { body } = dietSnapshotText(before, undefined);
  const { text } = dietSnapshotText(after, new Set(body));
  assert.match(text, /uid=1_100 StaticText "Done"/);
  assert.match(text, /gone since the last snapshot: 1_99\)/);
  // A changed line of a uid that is still there is not "gone".
  const renamed = before.replace('StaticText "Loading"', 'StaticText "Saving"');
  assert.doesNotMatch(dietSnapshotText(renamed, new Set(body)).text, /gone since/);
});

test('old previews are pruned and a large usage log is rotated', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ocean-browser-prune-'));
  for (const day of ['2026-11-01', '2026-11-19', 'notes']) mkdirSync(path.join(dir, 'shots', day), { recursive: true });
  mkdirSync(path.join(dir, 'snapshots', '2026-10-01'), { recursive: true });
  assert.equal(prunePreviews(dir, 7, new Date('2026-11-21T00:00:00Z')), 2);
  assert.deepEqual(readdirSync(path.join(dir, 'shots')).sort(), ['2026-11-19', 'notes']);
  const file = path.join(dir, 'usage.jsonl');
  writeFileSync(file, 'x'.repeat(20));
  assert.equal(rotateUsage(file, 100), false);
  assert.equal(rotateUsage(file, 10), true);
  assert.ok(existsSync(path.join(dir, 'usage.1.jsonl')));
  assert.ok(!existsSync(file));
});

test('a stuck page never holds a screenshot up', async () => {
  const page = { evaluate: () => new Promise(() => {}), screenshot: async () => 'image' };
  hideDuringScreenshots(page, 50);
  const started = Date.now();
  assert.equal(await page.screenshot(), 'image');
  assert.ok(Date.now() - started < 1000);
});

test('the slim profile screenshot also gets a preview', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ocean-browser-slim-'));
  const filter = createResponseFilter({ OCEAN_BROWSER_STATE_DIR: dir, OCEAN_BROWSER_USAGE: '0' });
  filter.observeInput(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screenshot', arguments: {} } })}\n`);
  const reply = JSON.parse(filter.transformOutput(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'image', mimeType: 'image/webp', data: 'AAAA' }] } })}\n`));
  assert.match(reply.result.content.at(-1).text, /^Preview: /);
});

test('an oversized snapshot keeps interactive elements and headings; the whole tree goes to a file', () => {
  const body = ['uid=1_0 RootWebArea "Big"', ...Array.from({ length: 2000 }, (_, i) => `  uid=1_${i + 1} StaticText "paragraph ${i} ${'x'.repeat(40)}"`), '  uid=1_5000 heading "History" level="2"', '  uid=1_5001 link "Edit" url="https://e.example/"', '  uid=1_5002 textbox "Search"'];
  const text = ['# take_snapshot response', '## Latest page snapshot', ...body, '## Console', 'none'].join('\n');
  let saved;
  const out = capSnapshotText(text, 2000, (whole) => { saved = whole; return '/state/snapshots/x.txt'; });
  assert.equal(saved, body.join('\n'));
  assert.match(out, /large page: [\d,]+ characters\. Showing interactive elements and headings\. Whole tree: \/state\/snapshots\/x\.txt/);
  for (const keep of ['RootWebArea', 'heading "History"', 'link "Edit"', 'textbox "Search"']) assert.ok(out.includes(keep), keep);
  assert.doesNotMatch(out, /paragraph 5 /);
  assert.match(out, /## Console\nnone$/);
  assert.equal(capSnapshotText(text, 0, () => 'x'), text);
  assert.equal(capSnapshotText('## Latest page snapshot\nuid=1_0 RootWebArea "s"', 2000, () => 'x'), '## Latest page snapshot\nuid=1_0 RootWebArea "s"');
  assert.equal(snapshotMax({}), 40_000);
  assert.equal(snapshotMax({ OCEAN_BROWSER_SNAPSHOT_MAX_CHARS: '0' }), 0);
});
