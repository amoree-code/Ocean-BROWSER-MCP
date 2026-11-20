// Reads the newline-delimited JSON-RPC stream both ways and rewrites upstream's replies, so
// upstream stays unforked. Requests are only read; replies are changed as follows:
// - tools/list: tools the profile hides are dropped (their schemas never reach the client).
// - Page tools keep only the selected tab in their `## Pages` block (list_pages keeps all).
// - An attached page snapshot (wait_for, input tools with includeSnapshot) shows only the lines
//   that changed since the last snapshot of that page; take_snapshot is always whole.
// - take_screenshot also saves the image to a file and names it, for terminals without images.
// - Each call appends one line (tool, sizes, time; never a URL) to the usage log.
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isOff, PROFILES, profileName, stateDir } from './config.mjs';

// The one tool whose job is listing tabs; every other tool's tab list is trimmed.
export const FULL_LIST_TOOLS = new Set(['list_pages']);
export const SNAPSHOT_HEADER = '## Latest page snapshot';
// A diff is used only when it saves this many lines and keeps at most this share of the tree.
const MIN_OMITTED = 20;
const MAX_CHANGED_SHARE = 0.6;
const MAX_GONE = 30;
// The usage log is rotated past this size; previews older than this many days are deleted.
const USAGE_MAX_BYTES = 5 * 1024 * 1024;
const PREVIEW_KEEP_DAYS = 7;
// A snapshot longer than this (OCEAN_BROWSER_SNAPSHOT_MAX_CHARS; 0 = no cap) is cut down to its
// interactive elements and headings; the whole tree goes to a file. Wikipedia's "Baghdad" page
// was 583,666 characters (~146K tokens) in one take_snapshot.
export const SNAPSHOT_MAX_CHARS = 40_000;
const KEEP_ROLES = new Set(['RootWebArea', 'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'listbox', 'heading', 'dialog', 'alertdialog', 'alert']);
// Tools whose reply carries a screenshot (`screenshot` is the slim profile's).
const SCREENSHOT_TOOLS = new Set(['take_screenshot', 'screenshot']);

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

// The snapshot block of a tool's text, if it has one. Snapshot uids are stable per page
// (upstream maps each DOM node to one uid), so an unchanged element keeps an identical line.
export function snapshotBlock(text) {
  const lines = text.split('\n');
  const start = lines.indexOf(SNAPSHOT_HEADER);
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('## ')) end += 1;
  return { lines, start, end, body: lines.slice(start + 1, end) };
}

// `previous` is the set of lines of the last snapshot of the same page, or undefined.
// Returns the text to send and the full body to remember.
export function dietSnapshotText(text, previous) {
  const block = snapshotBlock(text);
  if (!block) return { text, body: undefined };
  const { lines, start, end, body } = block;
  if (!previous) return { text, body };
  const changed = body.filter((line) => line.trim() && !previous.has(line));
  const omitted = body.filter((line) => line.trim()).length - changed.length;
  if (omitted < MIN_OMITTED || changed.length > body.length * MAX_CHANGED_SHARE)
    return { text, body };
  // Elements that left the page, by uid, so the agent does not act on one that is gone.
  const current = new Set(body);
  const gone = [...previous]
    .filter((line) => line.trim() && !current.has(line))
    .map((line) => line.match(/uid=(\S+)/)?.[1])
    .filter((uid) => uid && !body.some((line) => line.includes(`uid=${uid} `)));
  const kept = [
    `${SNAPSHOT_HEADER} (changes only)`,
    `(${omitted} unchanged lines left out; their uids still work. take_snapshot shows the whole tree.)`,
    ...changed,
  ];
  if (gone.length)
    kept.push(`(gone since the last snapshot: ${gone.slice(0, MAX_GONE).join(', ')}${gone.length > MAX_GONE ? ` and ${gone.length - MAX_GONE} more` : ''})`);
  return { text: [...lines.slice(0, start), ...kept, ...lines.slice(end)].join('\n'), body };
}

export function snapshotMax(env = process.env) {
  const raw = env.OCEAN_BROWSER_SNAPSHOT_MAX_CHARS;
  if (raw === undefined || raw === '') return SNAPSHOT_MAX_CHARS;
  const max = Number(raw);
  return Number.isFinite(max) && max >= 0 ? max : SNAPSHOT_MAX_CHARS;
}

// `save(fullBody)` stores the whole tree and returns its file (or undefined).
export function capSnapshotText(text, max, save) {
  if (!max) return text;
  const block = snapshotBlock(text);
  if (!block) return text;
  const { lines, start, end, body } = block;
  const size = body.reduce((sum, line) => sum + line.length + 1, 0);
  if (size <= max) return text;
  const kept = [];
  let used = 0;
  let dropped = 0;
  for (const line of body) {
    const role = line.trim().split(/\s+/)[1];
    if (!KEEP_ROLES.has(role)) continue;
    if (used + line.length + 1 > max) {
      dropped += 1;
      continue;
    }
    kept.push(line);
    used += line.length + 1;
  }
  const file = save(body.join('\n'));
  const note = [
    `(large page: ${size.toLocaleString('en')} characters. Showing interactive elements and headings${dropped ? `; ${dropped} more did not fit` : ''}.`,
    file ? ` Whole tree: ${file} — search it with your file tools.` : ' take_snapshot with filePath saves the whole tree.',
    ')',
  ].join('');
  return [...lines.slice(0, start + 1), note, ...kept, ...lines.slice(end)].join('\n');
}

// The first image of a screenshot reply goes to <state>/shots/<day>/<time>.<ext>; the reply
// gains a `Preview: <file>` line. Returns the reply unchanged when there is no image.
export function savePreview(result, dir, now = new Date()) {
  const image = result?.content?.find?.((item) => item?.type === 'image' && item.data);
  if (!image) return result;
  const ext = (image.mimeType?.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
  const file = stampedFile(dir, 'shots', ext, now);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(image.data, 'base64'));
  return { ...result, content: [...result.content, { type: 'text', text: `Preview: ${file}` }] };
}

// Deletes day-folders (shots/YYYY-MM-DD, snapshots/YYYY-MM-DD) older than `days`.
export function prunePreviews(dir, days = PREVIEW_KEEP_DAYS, now = new Date()) {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  let removed = 0;
  for (const kind of ['shots', 'snapshots']) {
    let names = [];
    try {
      names = readdirSync(path.join(dir, kind));
    } catch {
      continue;
    }
    for (const name of names)
      if (/^\d{4}-\d{2}-\d{2}$/.test(name) && name < cutoff) {
        rmSync(path.join(dir, kind, name), { recursive: true, force: true });
        removed += 1;
      }
  }
  return removed;
}

// <dir>/<kind>/<day>/<time>.<ext>
export function stampedFile(dir, kind, ext, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(dir, kind, stamp.slice(0, 10), `${stamp.slice(11, 23)}.${ext}`);
}

// Keeps one previous log: usage.jsonl → usage.1.jsonl once it passes `max` bytes.
export function rotateUsage(file, max = USAGE_MAX_BYTES) {
  try {
    if (statSync(file).size < max) return false;
  } catch {
    return false;
  }
  renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl'));
  return true;
}

const textChars = (result) =>
  (result?.content ?? []).reduce(
    (sum, item) => sum + (item?.type === 'text' ? (item.text?.length ?? 0) : 0),
    0,
  );

export function createResponseFilter(env = process.env, { now = () => Date.now() } = {}) {
  const profile = profileName(env);
  const hidden = new Set(PROFILES[profile].hide);
  const allTabs = env.OCEAN_BROWSER_ALL_TABS === '1';
  const fullSnapshots = env.OCEAN_BROWSER_FULL_SNAPSHOT === '1';
  const maxSnapshot = snapshotMax(env);
  const previews = !isOff(env.OCEAN_BROWSER_PREVIEW);
  const usage = !isOff(env.OCEAN_BROWSER_USAGE);
  const dir = stateDir(env);
  const requests = new Map();
  const snapshots = new Map();
  const state = { client: undefined };
  const inDecoder = new StringDecoder('utf8');
  const outDecoder = new StringDecoder('utf8');
  const decode = (decoder, chunk) => (typeof chunk === 'string' ? chunk : decoder.write(chunk));
  let inbound = '';
  let outbound = '';
  const parse = (line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  };
  // Never let bookkeeping break the stream.
  const quietly = (work, fallback) => {
    try {
      return work();
    } catch {
      return fallback;
    }
  };
  const usageFile = path.join(dir, 'usage.jsonl');
  let prepared = false;
  const prepare = () => {
    if (prepared) return;
    prepared = true;
    mkdirSync(dir, { recursive: true });
    rotateUsage(usageFile);
    prunePreviews(dir);
  };
  const log = (entry) => {
    if (!usage) return;
    quietly(() => {
      prepare();
      appendFileSync(
        usageFile,
        `${JSON.stringify({ t: new Date().toISOString(), client: state.client, profile, ...entry })}\n`,
      );
    });
  };

  const rewriteList = (result) => {
    const tools = Array.isArray(result?.tools) ? result.tools : undefined;
    if (!tools) return result;
    const kept = hidden.size ? tools.filter((tool) => !hidden.has(tool.name)) : tools;
    log({ tool: 'tools/list', count: kept.length, chars: JSON.stringify(kept).length });
    return kept === tools ? result : { ...result, tools: kept };
  };

  const rewriteCall = (request, result) => {
    let next = result;
    if (!allTabs && !FULL_LIST_TOOLS.has(request.tool)) next = trimToolResult(next);
    if (Array.isArray(next?.content)) {
      const key = request.args?.pageId ?? 'selected';
      let changed = false;
      const content = next.content.map((item) => {
        if (item?.type !== 'text' || typeof item.text !== 'string') return item;
        const previous = request.tool === 'take_snapshot' || fullSnapshots ? undefined : snapshots.get(key);
        const dieted = dietSnapshotText(item.text, previous);
        if (dieted.body) snapshots.set(key, new Set(dieted.body));
        const text = capSnapshotText(dieted.text, maxSnapshot, (whole) =>
          quietly(() => {
            prepare();
            const file = stampedFile(dir, 'snapshots', 'txt');
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, whole);
            return file;
          }),
        );
        if (text === item.text) return item;
        changed = true;
        return { ...item, text };
      });
      if (changed) next = { ...next, content };
    }
    if (previews && SCREENSHOT_TOOLS.has(request.tool) && !request.args?.filePath)
      next = quietly(() => {
        prepare();
        return savePreview(next, dir);
      }, next);
    const images = (next?.content ?? []).filter((item) => item?.type === 'image');
    log({
      tool: request.tool,
      chars: textChars(next),
      images: images.length,
      imageKB: Math.round(images.reduce((sum, item) => sum + (item.data?.length ?? 0) * 0.75, 0) / 1024),
      ms: now() - request.at,
      error: Boolean(next?.isError) || undefined,
    });
    return next;
  };

  return {
    state,
    observeInput(chunk) {
      inbound += decode(inDecoder, chunk);
      const lines = inbound.split('\n');
      inbound = lines.pop() ?? '';
      for (const line of lines) {
        const message = parse(line);
        if (message?.method === 'initialize')
          state.client = message.params?.clientInfo?.name ?? state.client;
        if (message?.id === undefined) continue;
        if (message.method === 'tools/call')
          requests.set(message.id, { tool: message.params?.name, args: message.params?.arguments, at: now() });
        else if (message.method === 'tools/list') requests.set(message.id, { list: true });
      }
    },
    // The complete lines ready to write; a partial line waits for the rest of it.
    transformOutput(chunk) {
      outbound += decode(outDecoder, chunk);
      const lines = outbound.split('\n');
      outbound = lines.pop() ?? '';
      return lines
        .map((line) => {
          const message = parse(line);
          if (!message || message.id === undefined || !requests.has(message.id)) return line;
          const request = requests.get(message.id);
          requests.delete(message.id);
          if (!message.result) return line;
          const result = request.list ? rewriteList(message.result) : rewriteCall(request, message.result);
          return result === message.result ? line : JSON.stringify({ ...message, result });
        })
        .map((line) => `${line}\n`)
        .join('');
    },
  };
}

// The name 0.2.0 exported; same filter.
export const createTabTrimmer = createResponseFilter;
