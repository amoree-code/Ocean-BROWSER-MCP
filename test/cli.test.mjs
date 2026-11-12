import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FLAGS, UPSTREAM, upstreamArgv, upstreamBin } from '../bin/cli.mjs';

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
