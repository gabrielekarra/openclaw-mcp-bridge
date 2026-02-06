# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

openclaw-mcp-bridge is an OpenClaw plugin that brings MCP (Model Context Protocol) support to OpenClaw. It uses **mcp-use** (TypeScript SDK) as the MCP backbone and adds a context-aware intelligence layer on top. The goal is MCP integration without the "token tax" that caused OpenClaw maintainers to reject native MCP support.

**Key design decision**: We use `MCPClient` from mcp-use for connections and tool discovery, but NOT `MCPAgent` (which brings its own LLM loop via LangChain). OpenClaw's own agent runtime handles LLM orchestration.

## Build & Development Commands

```bash
pnpm install                          # install dependencies
pnpm build                            # tsup → dist/index.js (ESM + CJS + DTS)
pnpm test                             # vitest run
pnpm test:watch                       # vitest in watch mode
pnpm test -- --grep "pattern"         # run specific test
pnpm lint                             # tsc --noEmit (type checking only)
```

## Architecture (675 LOC)

- **`src/index.ts`** — OpenClaw plugin entry point. Exports `mcpBridge(api)`. Registers `mcp_find_tools` meta-tool with context-aware filtering. Integrates analyzer, compressor, and cache. Includes `onBeforeAgentTurn` auto-injection for high-confidence tools.
- **`src/mcp-layer.ts`** — `McpLayer` class wrapping mcp-use's `MCPClient.fromDict()`. Handles tool discovery with 5-min TTL cache per server, tool execution delegation, and graceful per-server error handling (failed servers are skipped).
- **`src/context-analyzer.ts`** — `ContextAnalyzer` class with 4-layer relevance scoring: keyword match (0.4 weight), category match (0.3), intent match (0.2), history boost (0.1). All synchronous, no LLM calls.
- **`src/schema-compressor.ts`** — `SchemaCompressor` class. Truncates descriptions to 80 chars, keeps only required params, generates optional param hints. Reduces ~350 tokens/tool to ~60.
- **`src/result-cache.ts`** — `ResultCache` class. Caches read-only tool results (list/get/search/read patterns). TTL-based expiration, LRU eviction at capacity.
- **`src/discovery.ts`** — `discoverFromMcpJson()` reads `~/.mcp.json` and converts to `ServerEntry[]`. Handles missing file, invalid JSON, and both stdio/http server types.
- **`src/types.ts`** — All shared types: `ServerEntry`, `BridgeConfig`, `ToolWithServer`, `CachedToolSet`, `AnalyzerConfig`, `RelevanceScore`, `CompressedTool`, `CacheConfig`, `CacheEntry`.

Constructor merges explicit servers (from plugin config) with auto-discovered ones (from `~/.mcp.json`). Explicit entries win on name collision.

## Key Dependencies

- **mcp-use** — MCP TypeScript SDK. Key API: `MCPClient.fromDict({mcpServers})`, `client.createSession(name)` / `client.getSession(name)`, `session.listTools()`, `session.callTool(name, args)`, `client.close()`
- **tsup** — bundler (ESM + CJS + DTS output)
- **vitest** — test runner

## Configuration

Two modes:
1. **Auto-discover** (default): reads `~/.mcp.json` for server configs
2. **Explicit**: servers defined in OpenClaw plugin config with transport, command/url, env, headers, and category hints

Config schema is in `package.json` under `configSchema`. See `examples/` for sample OpenClaw configs.

## Open Questions

1. Does OpenClaw support dynamic/ephemeral tool registration mid-conversation? (currently uses `registerTool` at discovery time)
2. Does `onBeforeAgentTurn` hook exist in the plugin API? (used with optional chaining as fallback)
3. Can tool allowlisting use wildcards (`mcp_*`)?
