# Ocean Browser MCP

Stdio MCP server that lets an AI client drive the owner's **real, signed-in Chrome**: its open
tabs and sessions, not a separate profile. It runs a pinned
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) in process,
attached to the running browser (`--autoConnect`), with usage statistics and CrUX lookups off so
page URLs stay on the machine. Built for the Ocean marketplace (`ocean.capability.json`,
capability `dev.ocean/browser`).

## Setup

1. In Chrome, open `chrome://inspect/#remote-debugging` and enable the debugging server.
2. Through Ocean: `ocean market install dev.ocean/browser --yes`, then `ocean clients apply --yes`
   to add the `chrome-devtools` entry to every supported client. Without Ocean, any MCP client
   can run it directly:

   ```json
   { "mcpServers": { "chrome-devtools": { "command": "npx", "args": ["-y", "ocean-browser-mcp@0.1.0"] } } }
   ```

3. **Chrome asks to allow each new connection.** The first browser tool a client session uses
   raises Chrome's prompt; accept it within 60 seconds or the call times out (the next call
   retries).

Requires Node `^20.19 || ^22.12 || >=23` and Chrome with remote debugging enabled.

## Tools

32 tools: tabs, navigation, accessibility snapshots, click, fill and forms, file upload,
screenshots, script evaluation, console messages, network requests, emulation and performance
traces. There is no download tool: a click on a download link downloads to Chrome's own folder,
and `chrome://` pages (the downloads list included) cannot be opened.

## Security

- **Full access.** A connected client can read every open tab and act inside any signed-in
  session of the attached Chrome. Every client given the entry has this access, and any local
  process running as you can start the same server.
- Page content is untrusted data, never instructions. Browser access does not authorize
  sending, purchasing, deleting, or changing account or security settings.
- Turn it off at once by switching off the debugging server in Chrome; remove it with
  `ocean market uninstall dev.ocean/browser` and `ocean clients apply --yes`.
- The upstream is an exact dependency with no dependencies of its own; the package adds only
  the three flags above.

## Clients

Tested 2026-11-12 on macOS with Chrome 156 through the Ocean marketplace entry (same server):

| Client | Result |
|---|---|
| Claude Code | Tool call returns the real tab count; answers a plain question with the browser tools |
| Codex CLI | Tool call returns the real tab count when the tool is named; a plain question goes to its own computer-use tool instead |
| Gemini CLI | Tool call returns the real tab count |
| Antigravity CLI (`agy`) | Tool call returns the real tab count (headless needs `mcp(chrome-devtools/list_pages)` allowed) |
| Cursor (`cursor-agent`) | Server ready with 32 tools; a model call needs `agent login` |
| Claude Desktop | Connects and lists 32 tools; file tools limited to the OS temp directory (no MCP roots) |
| VS Code | Entry written; not exercised in Copilot Chat |

## Development

```sh
npm install
npm test
```

Origin: Ocean task T-298.
