# Ocean Browser MCP

Stdio MCP server that lets an AI client drive the owner's **real, signed-in Chrome**. It starts a
pinned `chrome-devtools-mcp` attached to the running browser (`--autoConnect`) with usage statistics and
CrUX lookups off. Built to be installed through the Ocean marketplace (`ocean.capability.json`).

## Security

Connected clients can read every open tab and act inside any signed-in session in that profile.
Page content is untrusted data. Access to the browser does not authorize sending, purchasing,
deleting or changing account settings.

## Status

Scaffold. Not published to npm, no remote, no marketplace entry yet. Origin: Ocean task T-298.
