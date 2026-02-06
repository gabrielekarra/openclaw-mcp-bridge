# openclaw-mcp-bridge

> Context-aware MCP support for OpenClaw — connect any MCP server without the token tax.

Built on [mcp-use](https://github.com/mcp-use/mcp-use). MIT licensed.

## Why?

OpenClaw doesn't natively support MCP. Existing workarounds dump all tools into the agent context, wasting tokens and confusing the AI. This plugin is different:

- **Smart filtering**: Only exposes tools relevant to what you're doing right now
- **Token efficient**: Compresses tool descriptions by ~83% (350 to 60 tokens per tool)
- **Zero startup cost**: Servers connect lazily, only when needed
- **Caching**: Read-only tool results are cached to reduce latency
- **Zero config**: Auto-discovers servers from your existing `~/.mcp.json`

## Quick Start

### Install

```bash
# From npm
openclaw plugins install openclaw-mcp-bridge

# Or from source
git clone https://github.com/gabrielekarra/openclaw-mcp-bridge.git
cd openclaw-mcp-bridge
pnpm install && pnpm build
openclaw plugins install .
```

### Minimal Setup (auto-discover)

If you already have MCP servers configured in `~/.mcp.json`, just enable the plugin:

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

Add `"mcp-bridge"` to your sandbox tool allowlist and restart: `openclaw gateway restart`

### Explicit Server Config

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
              "categories": ["productivity", "notes", "docs"]
            },
            {
              "name": "github",
              "transport": "stdio",
              "command": "npx",
              "args": ["-y", "@modelcontextprotocol/server-github"],
              "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
              "categories": ["code", "issues", "repos"]
            },
            {
              "name": "stripe",
              "transport": "http",
              "url": "http://localhost:3000/mcp",
              "headers": { "Authorization": "Bearer ${STRIPE_KEY}" },
              "categories": ["payments", "billing"]
            }
          ]
        }
      }
    }
  }
}
```

See [`examples/`](./examples) for copy-pasteable config snippets.

## How It Works

### The Token Tax Problem

A typical setup with 5 MCP servers exposes 50+ tools. Dumping all descriptions into the agent context costs ~5,000 tokens per turn — even when you're just asking about the weather.

### Our Solution

1. **You ask**: "Create a new page in Notion about our Q4 roadmap"
2. **Context Analyzer** scores all 50 tools using keyword matching, category overlap, intent detection, and usage history
3. **Top 5 tools** above the relevance threshold are selected (e.g., `notion/create_page` scores 85%)
4. **Schema Compressor** reduces each tool description from ~350 to ~60 tokens
5. **Agent gets**: 5 compressed tools (~300 tokens) instead of 50 verbose ones (~5,000 tokens)
6. **Result**: ~94% token savings, zero confusion

### Architecture

```
OpenClaw Agent
     |
mcp_find_tools (meta-tool)
     |
Context Analyzer -> Schema Compressor -> Register top tools
     |
mcp-use MCPClient -> MCP Servers (stdio/http/sse)
     |
Result Cache (read-only tools)
```

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
| `env` | object | no | Environment variables (supports `${VAR}` syntax) |
| `headers` | object | no | HTTP headers |
| `categories` | string[] | no | Hint categories for better relevance matching |

### Category Hints

Adding categories to servers improves relevance scoring. Recognized categories:
`productivity`, `notes`, `docs`, `code`, `dev`, `repos`, `issues`, `payments`, `billing`, `finance`, `filesystem`, `files`, `storage`, `search`, `discovery`, `communication`, `email`, `messaging`, `calendar`, `scheduling`, `database`, `data`, `media`, `images`, `devops`, `deployment`

## Development

```bash
pnpm install        # install deps
pnpm build          # build to dist/
pnpm test           # run tests (48+ tests)
pnpm lint           # type check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

## Roadmap

- [x] Phase 1: MCP connectivity via mcp-use
- [x] Phase 2: Context-aware filtering and compression
- [x] Phase 3: Polish and publish
- [ ] Phase 4: Semantic matching (embeddings-based tool relevance)
- [ ] Phase 4: MCP OAuth flow support
- [ ] Phase 4: OpenClaw CLI commands (`openclaw mcp-bridge status`)

## License

MIT

## Credits

- [OpenClaw](https://github.com/openclaw/openclaw) — the best personal AI agent
- [mcp-use](https://github.com/mcp-use/mcp-use) — MCP framework that powers our connections
- [Model Context Protocol](https://modelcontextprotocol.io) — the standard that makes this possible
