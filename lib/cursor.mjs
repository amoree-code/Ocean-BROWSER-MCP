// Shows the owner where the agent is working: a pointer that follows the agent's real mouse
// events (the technique of ghost-cursor's installMouseHelper and Puppeteer's mouse helper), a
// click ripple, and a glowing frame with an "Ocean · <client>" badge while tools act on a tab.
//
// Written here rather than taken from ghost-cursor because ghost-cursor sets <style>.innerHTML:
// pages with Trusted Types (Search Console, Gmail) reject that assignment and its listeners never
// attach. This uses a constructable stylesheet (not blocked by CSP or Trusted Types),
// textContent, and no URLs, so it works on those pages. Everything is pointer-events: none.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Runs in the page. Idempotent: installs once per document, then each call only pings.
export function pageOverlay(label) {
  const w = window;
  if (!w.__oceanAgent) {
    const css = `
      ocean-agent-pointer { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
        width: 22px; height: 26px; opacity: 0; transition: transform 140ms ease-out, opacity 200ms;
        filter: drop-shadow(0 0 1.5px #fff) drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
      ocean-agent-pointer.on { opacity: 1; }
      ocean-agent-pointer > i { display: block; width: 100%; height: 100%; background: #0b72e7;
        clip-path: polygon(0 0, 0 82%, 24% 63%, 40% 98%, 55% 92%, 40% 58%, 72% 58%); }
      ocean-agent-pointer::after { content: ''; position: absolute; left: -14px; top: -14px; width: 28px; height: 28px;
        border-radius: 50%; border: 2px solid #0b72e7; opacity: 0; transform: scale(.3); }
      ocean-agent-pointer.down::after { animation: ocean-agent-ripple 450ms ease-out; }
      @keyframes ocean-agent-ripple { from { opacity: .9; transform: scale(.3); } to { opacity: 0; transform: scale(1.6); } }
      ocean-agent-frame { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; opacity: 0;
        box-shadow: inset 0 0 0 3px rgba(11,114,231,.85), inset 0 0 18px rgba(11,114,231,.45); transition: opacity 250ms; }
      ocean-agent-frame.on { opacity: 1; }
      .ocean-agent-hidden { display: none !important; }
      ocean-agent-badge { position: absolute; top: 8px; inset-inline-end: 10px; padding: 3px 9px; border-radius: 999px;
        font: 600 12px/1.4 system-ui, sans-serif; color: #fff; background: rgba(11,114,231,.92); }
    `;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    const pointer = document.createElement('ocean-agent-pointer');
    pointer.appendChild(document.createElement('i'));
    const frame = document.createElement('ocean-agent-frame');
    const badge = document.createElement('ocean-agent-badge');
    frame.appendChild(badge);
    // Out of the accessibility tree, so page snapshots never include the overlay.
    for (const element of [pointer, frame]) element.setAttribute('aria-hidden', 'true');
    let idle;
    const attach = () => {
      if (!document.adoptedStyleSheets.includes(sheet))
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      if (!pointer.isConnected) document.documentElement.append(pointer, frame);
    };
    const move = (event) => {
      pointer.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
      pointer.classList.add('on');
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mousedown', (event) => {
      move(event);
      pointer.classList.remove('down');
      void pointer.offsetWidth; // restart the ripple
      pointer.classList.add('down');
    }, true);
    w.__oceanAgent = {
      // Screenshots are taken without the overlay.
      hide() {
        pointer.classList.add('ocean-agent-hidden');
        frame.classList.add('ocean-agent-hidden');
      },
      show() {
        pointer.classList.remove('ocean-agent-hidden');
        frame.classList.remove('ocean-agent-hidden');
      },
      ping(text) {
        attach();
        badge.textContent = text;
        frame.classList.add('on');
        clearTimeout(idle);
        idle = setTimeout(() => {
          frame.classList.remove('on');
          pointer.classList.remove('on');
        }, 2500);
      },
    };
  }
  if (document.documentElement) w.__oceanAgent.ping(label);
  else document.addEventListener('DOMContentLoaded', () => w.__oceanAgent.ping(label), { once: true });
}

export const overlayLabel = (client) => (client ? `Ocean · ${client}` : 'Ocean');

// Patches upstream's McpPage.init: page tools call init({ emulateFocus: true }) right before
// they act; tab discovery calls it with emulateFocus: false, so only tabs the agent works in get
// the overlay. The first install on a tab is awaited (at most FIRST_INSTALL_MS) so a click that is
// the first tool there already moves the pointer; later pings are fire-and-forget.
// `overlay: false` (OCEAN_BROWSER_CURSOR=0) leaves pages untouched.
export async function installCursor(upstreamFile, getClient = () => undefined, { overlay = true } = {}) {
  const pageFile = path.join(path.dirname(upstreamFile), '..', 'McpPage.js');
  const { McpPage } = await import(pathToFileURL(pageFile).href);
  const init = McpPage.prototype.init;
  const prepared = new WeakSet();
  McpPage.prototype.init = async function patchedInit(options, ...rest) {
    const result = await init.call(this, options, ...rest);
    if (options?.emulateFocus !== false) {
      const first = preparePage(this, prepared, overlay ? overlayLabel(getClient()) : undefined);
      if (first) await within(first, FIRST_INSTALL_MS);
    }
    return result;
  };
  return McpPage;
}

export const FIRST_INSTALL_MS = 300;

// Returns the overlay's install promise the first time a tab is seen, undefined after.
function preparePage(mcpPage, prepared, label) {
  let page;
  try {
    page = mcpPage.pptrPage;
  } catch {
    return undefined;
  }
  const now = label === undefined ? undefined : page.evaluate(pageOverlay, label).catch(() => {});
  if (prepared.has(page)) return undefined;
  prepared.add(page);
  if (label !== undefined) page.evaluateOnNewDocument(pageOverlay, label).catch(() => {});
  patchScreenshots(page, { overlay: label !== undefined });
  return now;
}

// A page script can be stuck (an alert() open, a busy loop); never wait on it longer than this.
export const HIDE_TIMEOUT_MS = 500;
export const within = (promise, ms) =>
  Promise.race([promise.catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms))]);

// Element screenshots go through page.screenshot too, so one wrapper per page covers both: the
// overlay is hidden while a screenshot is taken.
export function patchScreenshots(page, { overlay = true, timeout = HIDE_TIMEOUT_MS } = {}) {
  if (!overlay) return;
  const screenshot = page.screenshot.bind(page);
  page.screenshot = async (...args) => {
    await within(page.evaluate(() => window.__oceanAgent?.hide()), timeout);
    try {
      return await screenshot(...args);
    } finally {
      page.evaluate(() => window.__oceanAgent?.show()).catch(() => {});
    }
  };
}

// The earlier name; same patch.
export const hideDuringScreenshots = (page, timeout = HIDE_TIMEOUT_MS) => patchScreenshots(page, { timeout });
