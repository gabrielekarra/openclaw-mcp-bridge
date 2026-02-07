# openclaw-mcp-bridge v2 — MCP Aggregator Server

## Overview

A **standalone MCP aggregator server** that connects multiple downstream MCP servers and exposes them as one unified server via the standard MCP protocol (`tools/list`, `tools/call`). Includes a context-aware intelligence layer for filtering, compression, and caching.

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│            openclaw-mcp-bridge                                      │
│            (Smart MCP Aggregator Server)                            │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  MCP Server (@modelcontextprotocol/sdk)                     │   │
│   │  Exposes: tools/list, tools/call via standard MCP protocol  │   │
│   └──────────────────────┬──────────────────────────────────────┘   │
│                          │                                          │
│   ┌──────────────────────▼──────────────────────────────────────┐   │
│   │  Aggregator (facade)                                         │   │
│   │  ┌──────────────┐ ┌──────────────┐ ┌────────────────────┐  │   │
│   │  │   Context     │ │   Schema     │ │   Result           │  │   │
│   │  │   Analyzer    │ │   Compressor │ │   Cache            │  │   │
│   │  └──────────────┘ └──────────────┘ └────────────────────┘  │   │
│   └──────────────────────┬──────────────────────────────────────┘   │
│                          │                                          │
│   ┌──────────────────────▼──────────────────────────────────────┐   │
│   │  MCPClient (mcp-use)                                         │   │
│   │  Connects to downstream MCP servers                          │   │
│   └──────────────────────┬──────────────────────────────────────┘   │
│                          │                                          │
└──────────────────────────┼──────────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
 ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
 │  Notion MCP │   │  GitHub MCP │   │  Stripe MCP │
 │   (stdio)   │   │   (stdio)   │   │   (http)    │
 └─────────────┘   └─────────────┘   └─────────────┘
```

**Who connects to us:**

```
┌──────────────────────┐
│  OpenClaw (plugin)    │──── direct ────────┐
└──────────────────────┘                     │
                                             ▼
┌──────────────────────┐          ┌──────────────────────┐
│  Claude Desktop       │── stdio ─▶│  openclaw-mcp-bridge │
└──────────────────────┘          │  (aggregator server)  │
                                  └──────────────────────┘
┌──────────────────────┐                     ▲
│  Cursor / Windsurf    │── stdio/http ──────┘
└──────────────────────┘
```

---

## Directory Structure

```
src/
├── core/
│   ├── types.ts              # Shared types (ServerEntry, BridgeConfig, etc.)
│   ├── discovery.ts          # Auto-discover servers from ~/.mcp.json
│   ├── mcp-layer.ts          # MCPClient wrapper (mcp-use) with tool discovery + execution
│   ├── context-analyzer.ts   # 4-layer relevance scoring (keyword, category, intent, history)
│   ├── schema-compressor.ts  # Compress tool schemas for minimal token usage
│   ├── result-cache.ts       # TTL-based cache for read-only tool results
│   ├── aggregator.ts         # Facade composing all core modules
│   └── index.ts              # Barrel re-export
├── server/
│   ├── index.ts              # Standalone MCP server entry point (stdio)
│   └── cli.ts                # CLI arg parsing + config loading
├── plugin/
│   └── index.ts              # OpenClaw plugin entry (registers tools via plugin API)
└── index.ts                  # Package root (re-exports plugin default + core)
```

---

## Key Components

### Aggregator (`src/core/aggregator.ts`)

Facade that composes McpLayer, ContextAnalyzer, SchemaCompressor, and ResultCache:
- `refreshTools()` — discovers tools from all downstream servers, builds route map
- `getToolList()` — returns `find_tools` meta-tool + all compressed downstream tools (MCP `Tool` shape)
- `callTool(name, params)` — routes `find_tools` to analyzer, regular tools to downstream via McpLayer with caching
- `shutdown()` — delegates to McpLayer

### MCP Server (`src/server/index.ts`)

Uses `@modelcontextprotocol/sdk` directly:
- `Server` from `@modelcontextprotocol/sdk/server/index.js`
- `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`
- Registers `ListToolsRequestSchema` and `CallToolRequestSchema` handlers
- All logs to stderr (stdout is JSON-RPC)
- Graceful shutdown on SIGINT/SIGTERM

### Intelligence Layer (core modules)

- **ContextAnalyzer** — 4-layer scoring: keyword (0.4), category (0.3), intent (0.2), history (0.1). All synchronous, no LLM calls.
- **SchemaCompressor** — Truncates descriptions to 80 chars, keeps only required params, ~350→~60 tokens/tool.
- **ResultCache** — Caches read-only results (list/get/search/read patterns). TTL-based expiration, LRU eviction.
- **McpLayer** — Wraps mcp-use `MCPClient.fromDict()`. 5-min TTL cache per server. Failed servers skipped gracefully.

---

## Deployment Modes

### Mode 1: Standalone MCP Server

```bash
npx openclaw-mcp-bridge --config ./bridge-config.json
```

In `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "bridge": {
      "command": "npx",
      "args": ["openclaw-mcp-bridge", "--config", "~/.mcp-bridge.json"]
    }
  }
}
```

### Mode 2: OpenClaw Plugin

```json
{
  "plugins": {
    "entries": {
      "mcp-bridge": {
        "enabled": true,
        "config": { "autoDiscover": true }
      }
    }
  }
}
```

Plugin provides extra features: `mcp_find_tools`, `mcp_call_tool`, and `mcp_list_servers` for explicit discovery + invocation flow.
In traditional mode, downstream tools are registered as `mcp_<server>_<tool>` names.

---

## Key Dependencies

- **mcp-use** — MCP TypeScript SDK for downstream connections. Key API: `MCPClient.fromDict()`, `session.listTools()`, `session.callTool()`
- **@modelcontextprotocol/sdk** — Official MCP SDK for the server side. Key API: `Server`, `StdioServerTransport`, request schemas
- **tsup** — bundler (ESM + CJS + DTS, multi-entry)
- **vitest** — test runner
