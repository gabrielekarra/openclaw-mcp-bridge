# openclaw-mcp-bridge

> Smart MCP aggregator — connect any MCP server to OpenClaw (or any MCP client) without the token tax.

Built on [mcp-use](https://github.com/mcp-use/mcp-use) and [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk). MIT licensed.

## What It Does

Connects multiple MCP servers and exposes them as one unified server. A context-aware intelligence layer filters, compresses, and caches tool descriptions so your agent only sees what's relevant — saving ~94% of the tokens typically wasted on tool descriptions.

Works as:
1. **Standalone MCP server** — any MCP client (Claude Desktop, Cursor, etc.) connects via stdio
2. **OpenClaw plugin** — deeper integration with conversation-aware tool filtering

## Installation

### As an OpenClaw Plugin

```bash
# From GitHub
openclaw plugins install gabrielekarra/openclaw-mcp-bridge

# From npm (when published)
openclaw plugins install openclaw-mcp-bridge
```

### As a Standalone MCP Server

```bash
npx openclaw-mcp-bridge --config ./bridge-config.json
```

For Claude Desktop, add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bridge": {
      "command": "npx",
      "args": ["openclaw-mcp-bridge", "--config", "/path/to/bridge-config.json"]
    }
  }
}
```

## Configuration (OpenClaw Plugin)

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "mcp-bridge": {
        "enabled": true,
        "config": {
          "autoDiscover": true
        }
      }
    }
  }
}
```

> The key MUST be `mcp-bridge` — this matches the plugin ID in `openclaw.plugin.json`.

Then restart OpenClaw:

```bash
openclaw gateway restart
```

### Auto-Discovery

When `autoDiscover: true` (default), the plugin reads `~/.mcp.json` and imports any MCP servers defined there. This is the same config file used by Claude Desktop.

Example `~/.mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    },
    "notion": {
      "command": "npx",
      "args": ["-y", "@notionhq/mcp-server"]
    }
  }
}
```

### Explicit Servers

You can also define servers directly in the plugin config:

```json
{
  "plugins": {
    "entries": {
      "mcp-bridge": {
        "enabled": true,
        "config": {
          "autoDiscover": false,
          "servers": [
            {
              "name": "github",
              "transport": "stdio",
              "command": "npx",
              "args": ["-y", "@modelcontextprotocol/server-github"],
              "categories": ["code", "issues", "repos"]
            }
          ]
        }
      }
    }
  }
}
```

See [`examples/`](./examples) for copy-pasteable config snippets.

## Usage

The plugin registers two tools that the agent can use:

### `mcp_find_tools`

Discovers relevant tools from your connected MCP servers.

**Examples — just ask the agent naturally:**
- "Find tools to create a GitHub issue"
- "What MCP tools can search my Notion workspace?"
- "Show me all available MCP tools"

The agent will call `mcp_find_tools` automatically and get back a ranked list of matching tools, which it can then use directly.

### `mcp_list_servers`

Shows all connected MCP servers and their status.

**Examples:**
- "What MCP servers are connected?"
- "Check MCP status"
- "List my tool servers"

### How the flow works

1. You ask the agent to do something that needs an external tool
2. Agent calls `mcp_find_tools` with your request
3. Plugin searches across all MCP servers, ranks results by relevance
4. Agent receives matching tools and calls the one it needs
5. Plugin routes the call to the correct MCP server and returns the result

All of this happens automatically — you just talk to the agent normally.

## How It Works

A typical setup with 5 MCP servers exposes 50+ tools. Dumping all descriptions into the agent context costs ~5,000 tokens per turn — even when you're just asking about the weather.

Our solution:

1. **You ask**: "Create a new page in Notion about our Q4 roadmap"
2. **Context Analyzer** scores all tools using keyword matching, category overlap, intent detection, and usage history
3. **Top 5 tools** above the relevance threshold are selected
4. **Schema Compressor** reduces each tool description from ~350 to ~60 tokens
5. **Result**: ~94% token savings, zero confusion

## Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `servers` | array | `[]` | Explicit MCP server configurations |
| `autoDiscover` | boolean | `true` | Scan `~/.mcp.json` for servers |
| `analyzer.maxToolsPerTurn` | number | `5` | Max tools exposed per agent turn |
| `analyzer.relevanceThreshold` | number | `0.3` | Minimum relevance score (0-1) |
| `analyzer.highConfidenceThreshold` | number | `0.7` | Auto-inject threshold |
| `cache.enabled` | boolean | `true` | Enable result caching |
| `cache.ttlMs` | number | `30000` | Cache TTL in milliseconds |

### Server Entry

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique server identifier |
| `transport` | `"stdio"` / `"http"` / `"sse"` | yes | Transport protocol |
| `command` | string | stdio only | Command to spawn |
| `args` | string[] | stdio only | Command arguments |
| `url` | string | http/sse only | Server URL |
| `env` | object | no | Environment variables |
| `headers` | object | no | HTTP headers |
| `categories` | string[] | no | Hint categories for better relevance matching |

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `plugin not found: mcp-bridge` | Plugin not installed | Run `openclaw plugins install gabrielekarra/openclaw-mcp-bridge` |
| `plugin manifest not found` | Missing `openclaw.plugin.json` | Reinstall the plugin (fixed in latest version) |
| `openclaw.extensions is empty` | Wrong extensions format | Update to latest version (fixed) |
| `extension entry not found: {"type":...}` | Old extensions format | Update to latest version |
| No MCP servers found | Missing `~/.mcp.json` or `autoDiscover: false` | Create `~/.mcp.json` or add explicit `servers` in config |

## Development

```bash
pnpm install        # install deps
pnpm build          # build to dist/ (multi-entry: core, server, plugin)
pnpm test           # run tests (74 tests)
pnpm lint           # type check
pnpm start          # run MCP aggregator server (stdio)
```

## License

MIT

## Credits

- [OpenClaw](https://github.com/openclaw/openclaw) — the best personal AI agent
- [mcp-use](https://github.com/mcp-use/mcp-use) — MCP framework that powers our connections
- [Model Context Protocol](https://modelcontextprotocol.io) — the standard that makes this possible
