# openclaw-mcp-bridge

A context-aware MCP (Model Context Protocol) bridge for OpenClaw. Connects OpenClaw's agent to any MCP server — Notion, GitHub, Stripe, and more — using [mcp-use](https://github.com/mcp-use/mcp-use) as the transport backbone.

## Installation

```bash
# Build the plugin
pnpm install
pnpm build

# Install in OpenClaw
openclaw plugins install ./openclaw-mcp-bridge
```

## Configuration

### Minimal — auto-discover from ~/.mcp.json

If you already have MCP servers configured in `~/.mcp.json` (the standard MCP config file), the plugin picks them up automatically:

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

### Explicit server configuration

Define servers directly in your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "mcp-bridge": {
        "enabled": true,
        "config": {
          "servers": [
            {
              "name": "notion",
              "transport": "stdio",
              "command": "npx",
              "args": ["-y", "@notionhq/mcp"],
              "env": { "NOTION_API_KEY": "${NOTION_API_KEY}" },
              "categories": ["productivity", "notes"]
            },
            {
              "name": "github",
              "transport": "stdio",
              "command": "npx",
              "args": ["-y", "@modelcontextprotocol/server-github"],
              "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
              "categories": ["code", "issues"]
            }
          ]
        }
      }
    }
  }
}
```

See [`examples/`](./examples) for more configuration examples.

## How it works

1. The plugin registers a `mcp_find_tools` meta-tool in OpenClaw
2. When the agent needs an external capability, it calls `mcp_find_tools({ need: "create a notion page" })`
3. The plugin connects to all configured MCP servers via mcp-use and discovers available tools
4. Each discovered tool is registered as a callable tool (e.g., `mcp_notion_create_page`)
5. The agent can then call these tools directly

The plugin uses `MCPClient` from mcp-use for all MCP communication (stdio, HTTP, SSE transports), tool discovery, and execution. It does **not** use mcp-use's `MCPAgent` — OpenClaw has its own LLM runtime.

## Roadmap

**Phase 2** (coming soon): Context-aware tool filtering that scores tools by relevance to the current conversation. Instead of exposing all tools, only the most relevant ones are surfaced — saving tokens and reducing agent confusion. Includes schema compression (~350 tokens per tool down to ~60) and result caching for read-only operations.

## License

MIT
