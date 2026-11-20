// What the wrapper passes to upstream, and where it keeps its own files. Everything here is read
// from the environment once per process, so the market entry (or a client config) sets it.
import os from 'node:os';
import path from 'node:path';

export const UPSTREAM = 'chrome-devtools-mcp';

// Attach to the running browser; nothing leaves the machine; safer and cheaper defaults.
// - redactNetworkHeaders: cookies and auth headers never reach the model.
// - no-file-navigations: an agent cannot open file:// pages.
// - webp, quality 70: a screenshot is a fraction of upstream's PNG and stays inline. No
//   --screenshotMaxWidth: upstream downscales through a clip, which makes Chrome re-render the
//   whole page shrunken (seen on screen) and took ~12 s on a long page; clients downscale
//   images themselves.
export const FLAGS = [
  '--autoConnect',
  '--no-usage-statistics',
  '--no-performance-crux',
  '--redactNetworkHeaders',
  '--no-file-navigations',
  '--screenshotFormat=webp',
  '--screenshotQuality=70',
];

// Tool profiles (OCEAN_BROWSER_PROFILE). `hide` drops tools from tools/list so a client never
// loads their schemas; `flags` turns whole upstream categories off. Measured on 1.13.0: full
// 33 tools ≈ 8.1K tokens of schema; slim 3 tools ≈ 0.3K.
export const PROFILES = {
  full: { flags: [], hide: [] },
  // Default: everything the owner uses (forms, network, console, Lighthouse, traces, emulation).
  standard: {
    flags: ['--no-category-memory'],
    hide: ['set_logpoints', 'screencast_start', 'screencast_stop'],
  },
  // Browsing only: no performance, emulation, CSS or drag tools.
  lean: {
    flags: ['--no-category-memory', '--no-category-performance', '--no-category-emulation'],
    hide: ['set_logpoints', 'screencast_start', 'screencast_stop', 'get_css_styles', 'drag'],
  },
  // Upstream's 3 tools: navigate, evaluate, screenshot.
  slim: { flags: ['--slim'], hide: [] },
};
export const DEFAULT_PROFILE = 'standard';

export function profileName(env = process.env) {
  const name = (env.OCEAN_BROWSER_PROFILE ?? '').trim().toLowerCase();
  return Object.hasOwn(PROFILES, name) ? name : DEFAULT_PROFILE;
}

// OCEAN_BROWSER_BLOCKED: URL patterns (https://urlpattern.spec.whatwg.org/), one per line or
// comma-separated. The browser refuses to load them while the agent is attached.
export function blockedPatterns(env = process.env) {
  return (env.OCEAN_BROWSER_BLOCKED ?? '')
    .split(/[\n,]/)
    .map((each) => each.trim())
    .filter(Boolean);
}

// Defaults first, so an explicit argument from the caller can still override one.
export function upstreamArgv(extra = [], env = process.env) {
  return [
    ...FLAGS,
    ...PROFILES[profileName(env)].flags,
    ...blockedPatterns(env).flatMap((pattern) => ['--blockedUrlPattern', pattern]),
    ...extra,
  ];
}

// Usage log and screenshot previews. OCEAN_BROWSER_STATE_DIR wins, then XDG state.
export function stateDir(env = process.env) {
  if (env.OCEAN_BROWSER_STATE_DIR) return env.OCEAN_BROWSER_STATE_DIR;
  const base = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'ocean-browser-mcp');
}

export const isOff = (value) => value === '0' || value === 'false';
