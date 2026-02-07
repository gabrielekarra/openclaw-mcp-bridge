# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

openclaw-mcp-bridge is an **MCP aggregator server** that connects multiple downstream MCP servers and exposes them as one unified server via the standard MCP protocol. It also works as an OpenClaw plugin for deeper integration. Uses **mcp-use** for downstream connections and **@modelcontextprotocol/sdk** for the server side. Includes a context-aware intelligence layer (filtering + caching) to reduce tool selection noise.

**Key design decision**: We use `MCPClient` from mcp-use for connections and tool discovery, but NOT `MCPAgent` (which brings its own LLM loop via LangChain). For the server side, we use `Server` from `@modelcontextprotocol/sdk` directly (not mcp-use's HTTP-only `MCPServer`).

## Build & Development Commands

```bash
pnpm install                          # install dependencies
pnpm build                            # tsup → dist/ (ESM + CJS + DTS, multi-entry)
pnpm test                             # vitest run
pnpm test:watch                       # vitest in watch mode
pnpm test -- --grep "pattern"         # run specific test
pnpm lint                             # tsc --noEmit (type checking only)
pnpm start                            # run the MCP aggregator server (stdio)
```

## Architecture

```
src/
├── core/
│   ├── types.ts              — Shared types (ServerEntry, BridgeConfig, ToolWithServer, etc.)
│   ├── discovery.ts          — discoverFromMcpJson() reads ~/.mcp.json → ServerEntry[]
│   ├── mcp-layer.ts          — McpLayer: MCPClient wrapper, tool discovery (5-min TTL), execution
│   ├── context-analyzer.ts   — ContextAnalyzer: 4-layer relevance scoring (keyword/category/intent/history)
│   ├── schema-compressor.ts  — SchemaCompressor: truncate descriptions, keep required params (~350→~60 tokens)
│   ├── result-cache.ts       — ResultCache: TTL-based cache for read-only tool results, LRU eviction
│   ├── aggregator.ts         — Aggregator: facade composing all core modules
│   └── index.ts              — Barrel re-export
├── server/
│   ├── index.ts              — Standalone MCP server (stdio via @modelcontextprotocol/sdk)
│   └── cli.ts                — CLI arg parsing (--config, --http, --port) + config loading
├── plugin/
│   └── index.ts              — OpenClaw plugin entry (`mcp_find_tools`, `mcp_call_tool`, `mcp_list_servers`)
└── index.ts                  — Package root (re-exports plugin default + core)
```

## Key Dependencies

- **mcp-use** — MCP TypeScript SDK for downstream connections. API: `MCPClient.fromDict({mcpServers})`, `client.createSession(name)` / `client.getSession(name)`, `session.listTools()`, `session.callTool(name, args)`, `client.close()`
- **@modelcontextprotocol/sdk** — Official MCP SDK for the server side. API: `Server`, `StdioServerTransport`, `ListToolsRequestSchema`, `CallToolRequestSchema`
- **tsup** — bundler (ESM + CJS + DTS, multi-entry: src/index.ts, src/core/index.ts, src/server/index.ts)
- **vitest** — test runner

## Configuration

Two modes:
1. **Auto-discover** (default): reads `~/.mcp.json` for server configs
2. **Explicit**: servers defined in config with transport, command/url, env, headers, and category hints

Plugin config schema is in `openclaw.plugin.json`. See `examples/` for sample configs.

## Deployment Modes

1. **Standalone MCP server**: `npx openclaw-mcp-bridge --config ./config.json` — any MCP client connects via stdio
2. **OpenClaw plugin**: deeper integration with `mcp_find_tools`, `mcp_call_tool`, `mcp_list_servers`
