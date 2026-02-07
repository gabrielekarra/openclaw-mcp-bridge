# openclaw-mcp-bridge

Smart MCP bridge for OpenClaw and other MCP clients.

This project connects multiple MCP servers and exposes them through one interface, with relevance filtering and optional caching.

Built on [mcp-use](https://github.com/mcp-use/mcp-use) and [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk).

## Project Status

This package is not published to npm right now.
Use it locally by cloning this repository.

## Quick Start (Local)

### Prerequisites

- Node.js `20.19+` (recommended)
- `pnpm`
- OpenClaw (only if you want plugin mode)

### Clone and Build

```bash
git clone https://github.com/gabrielekarra/openclaw-mcp-bridge.git
cd openclaw-mcp-bridge
pnpm install
pnpm build
```

## Usage Modes

### 1. OpenClaw Plugin (Local)

Install the plugin from the local repository:

```bash
openclaw plugins install .
openclaw gateway restart
```

Enable/configure it in `~/.openclaw/openclaw.json`:

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

Notes:
- Plugin key must be `mcp-bridge` (matches `openclaw.plugin.json`).
- With `autoDiscover: true`, it reads MCP servers from `~/.mcp.json`.

### 2. Standalone MCP Server

Run the bridge server directly:

```bash
pnpm start -- --config ./examples/bridge-config.json
```

You can also run it directly with Node:

```bash
node dist/server/index.js --config ./examples/bridge-config.json
```

For Claude Desktop, add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bridge": {
      "command": "node",
      "args": [
        "/absolute/path/to/openclaw-mcp-bridge/dist/server/index.js",
        "--config",
        "/absolute/path/to/openclaw-mcp-bridge/examples/bridge-config.json"
      ]
    }
  }
}
```

## Operating Modes

The plugin supports two operating modes controlled by one config key:

```json
{
  "mode": "smart"
}
```

- `smart` (default, original design): uses relevance analysis, ranking, thresholds, and optional caching.
- `traditional`: registers all discovered MCP tools at startup with no relevance filtering or lazy tool activation.

Migration note:
- If you want all MCP tools always visible, use `mode: traditional`.

### Smart mode example (default)

```json
{
  "plugins": {
    "entries": {
      "mcp-bridge": {
        "enabled": true,
        "config": {
          "mode": "smart",
          "autoDiscover": true
        }
      }
    }
  }
}
```

### Traditional mode example

```json
{
  "plugins": {
    "entries": {
      "mcp-bridge": {
        "enabled": true,
        "config": {
          "mode": "traditional",
          "autoDiscover": true
        }
      }
    }
  }
}
```

## Registered Tools (Plugin Mode)

### Smart mode tools

### `mcp_find_tools`

Finds available tools from connected MCP servers.

Examples:
- "Find tools to create a GitHub issue"
- "What tools are available for Notion?"
- "List all MCP tools"

Behavior:
- If `need` is present, tools are ranked by relevance.
- If `need` is empty/missing, it returns available tools (capped for readability).
- Results include `server` + `name` values used by `mcp_call_tool`.

### `mcp_call_tool`

Calls a downstream tool returned by `mcp_find_tools`.

Required params:
- `server` (string)
- `tool` (string)

Optional params:
- `arguments` (object)

Example call payload:

```json
{
  "server": "notion",
  "tool": "create_page",
  "arguments": {
    "title": "Roadmap"
  }
}
```

### `mcp_list_servers`

Lists configured MCP servers with discovered tool counts.

Examples:
- "What MCP servers are connected?"
- "Show me available servers"

### Traditional mode tools

- Registers every discovered MCP tool at startup.
- Tool names are namespaced as `mcp_<server>_<tool>`.
- Each registered tool directly calls its underlying MCP server tool.

## How the Flow Works

1. User asks for a task that likely needs an external tool.
2. Agent calls `mcp_find_tools`.
3. Bridge discovers tools across MCP servers and ranks matches.
4. Agent calls `mcp_call_tool` with the selected `server` + `tool`.
5. Bridge routes the call to the correct MCP server.

## Configuration

### Auto-discovery from `~/.mcp.json`

When enabled, the bridge imports servers from `~/.mcp.json`.

Example:

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

### Explicit server config

You can provide `servers` explicitly in plugin config:

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

See `examples/` for ready-to-use configs.

Standalone note:
- `loadConfig()` accepts both standalone bridge shape (`{ mode, servers, ... }`) and OpenClaw plugin shape (`plugins.entries["mcp-bridge"].config`).

## Config Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `mode` | `"smart" \| "traditional"` | `"smart"` | Operating mode |
| `servers` | array | `[]` | Explicit MCP server definitions |
| `autoDiscover` | boolean | `true` | Load servers from `~/.mcp.json` |
| `analyzer.maxToolsPerTurn` | number | `5` | Maximum ranked tools returned (`smart` mode only) |
| `analyzer.relevanceThreshold` | number | `0.3` | Minimum relevance score (`smart` mode only) |
| `cache.enabled` | boolean | `true` | Enable result cache (`smart` mode only) |
| `cache.ttlMs` | number | `30000` | Cache TTL in ms (`smart` mode only) |
| `cache.maxEntries` | number | `100` | Max cache entries (`smart` mode only) |

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

## Troubleshooting

| Issue | Likely cause | Fix |
|---|---|---|
| `plugin not found: mcp-bridge` | Plugin not installed locally | Run `openclaw plugins install .` from repo root |
| No MCP servers detected | Missing `~/.mcp.json` and no explicit `servers` | Add `~/.mcp.json` or set `servers` in plugin config |
| Tools not matching user intent | Query too narrow / threshold too high | Broaden `need` text or lower `analyzer.relevanceThreshold` |
| Tool was found but not executed | Agent tried to call tool directly | Call `mcp_call_tool` with `{ server, tool, arguments }` |
| Standalone server not starting | Wrong Node version | Use Node `20.19+` |
| `@modelcontextprotocol/ext-apps` postinstall warning on newer Node versions | Optional setup script warning | Harmless for this project; install/build can continue |

## License

MIT

## Credits

- [OpenClaw](https://github.com/openclaw/openclaw) — the best personal AI agent
- [mcp-use](https://github.com/mcp-use/mcp-use) — MCP framework that powers our connections
- [Model Context Protocol](https://modelcontextprotocol.io) — the standard that makes this possible
