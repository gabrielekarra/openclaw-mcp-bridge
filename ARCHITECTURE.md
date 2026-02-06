# 🦞 openclaw-mcp-bridge — Architecture & Development Plan
## Built on mcp-use

---

## TL;DR

An OpenClaw plugin that uses **mcp-use** (TypeScript SDK) as the MCP backbone, adding a context-aware intelligence layer on top. mcp-use handles transports, connections, and server management. We handle smart tool filtering, schema compression, and seamless OpenClaw integration.

---

## The Problem

OpenClaw doesn't natively support MCP. The maintainers rejected it citing:
- **Token burn**: too many tool descriptions flood agent context
- **Latency**: extra round-trips per call
- **Complexity**: managing child processes is fragile
- **Noise**: "most MCPs are useless" — too many tools confuse the agent

Existing workarounds (mcporter, openclaw-mcp-adapter) either force MCP-specific thinking or dump all tools blindly.

## Why mcp-use

Instead of reimplementing MCP transports from scratch, we leverage mcp-use's TypeScript SDK which already provides:

| Feature | mcp-use provides | We build on top |
|---------|-----------------|-----------------|
| Stdio/HTTP/SSE transports | ✅ `MCPClient` | — |
| Multi-server connections | ✅ `MCPClient.fromDict()` | — |
| Dynamic server selection | ✅ `useServerManager` | Enhanced with context analysis |
| Tool listing & calling | ✅ `MCPAgent` + `MCPClient` | Filtered & compressed |
| Streaming support | ✅ `stream()` / `streamEvents()` | Passed through |
| LLM integration | ✅ LangChain adapters | Not used (OpenClaw has its own) |
| Server framework | ✅ `createMCPServer()` | Used for the aggregator pattern |

**Key insight**: We do NOT use mcp-use's MCPAgent (it brings its own LLM loop via LangChain). Instead we use `MCPClient` directly for connections and tool discovery, then expose tools to OpenClaw's own agent runtime.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                       │
│                                                          │
│  ┌──────────┐       ┌──────────────────────────────┐    │
│  │  Agent    │◄─────►│     openclaw-mcp-bridge      │    │
│  │  Runtime  │       │                              │    │
│  │  (Pi)     │       │  ┌────────────────────────┐  │    │
│  └──────────┘       │  │  Context Analyzer       │  │    │
│       │              │  │  (relevance scoring)    │  │    │
│       │              │  └───────────┬────────────┘  │    │
│       │              │              │               │    │
│       │              │  ┌───────────▼────────────┐  │    │
│       │              │  │  Schema Compressor      │  │    │
│       │              │  │  (token optimization)   │  │    │
│       │              │  └───────────┬────────────┘  │    │
│       │              │              │               │    │
│       │              │  ┌───────────▼────────────┐  │    │
│       │              │  │  mcp-use MCPClient      │  │    │
│       │              │  │  (handles everything)   │  │    │
│       │              │  └───────────┬────────────┘  │    │
│       │              └──────────────┼───────────────┘    │
└───────┼─────────────────────────────┼────────────────────┘
        │                             │
        │          ┌──────────────────┼──────────────────┐
        │          │                  │                  │
        │   ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
        │   │  MCP Server │   │  MCP Server │   │  MCP Server │
        │   │  (Notion)   │   │  (GitHub)   │   │  (Stripe)   │
        │   └─────────────┘   └─────────────┘   └─────────────┘
        │
        │   mcp-use handles: stdio spawn, HTTP/SSE,
        │   JSON-RPC, tools/list, tools/call
        │
```

---

## Core Components

### 1. mcp-use Integration Layer

The foundation. Uses `MCPClient` from mcp-use for all MCP communication.

```typescript
// src/mcp-layer.ts
import { MCPClient } from 'mcp-use';

interface BridgeConfig {
  servers: ServerEntry[];
  autoDiscover: boolean;       // scan ~/.mcp.json
}

interface ServerEntry {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;            // stdio
  args?: string[];             // stdio
  url?: string;                // http/sse
  env?: Record<string, string>;
  headers?: Record<string, string>;
  categories?: string[];       // hints for relevance matching
}

class McpLayer {
  private client: MCPClient;
  private toolCache: Map<string, CachedToolSet> = new Map();

  constructor(config: BridgeConfig) {
    // Convert our config to mcp-use's format
    const mcpConfig: Record<string, any> = {};
    for (const server of config.servers) {
      if (server.transport === 'stdio') {
        mcpConfig[server.name] = {
          command: server.command,
          args: server.args,
          env: server.env,
        };
      } else {
        mcpConfig[server.name] = {
          url: server.url,
          headers: server.headers,
        };
      }
    }
    // mcp-use handles ALL transport complexity
    this.client = MCPClient.fromDict({ mcpServers: mcpConfig });
  }

  /**
   * Discover all tools from all configured servers.
   * mcp-use connects lazily — first call triggers connection.
   * We cache results to avoid repeated round-trips.
   */
  async discoverTools(): Promise<ToolWithServer[]> {
    const sessions = await this.client.getOrCreateSessions();
    const allTools: ToolWithServer[] = [];

    for (const [serverName, session] of Object.entries(sessions)) {
      if (this.toolCache.has(serverName) && !this.toolCache.get(serverName)!.isStale()) {
        allTools.push(...this.toolCache.get(serverName)!.tools);
        continue;
      }

      const tools = await session.listTools();
      const enriched = tools.map(t => ({
        ...t,
        serverName,
        categories: this.getServerCategories(serverName),
      }));

      this.toolCache.set(serverName, new CachedToolSet(enriched));
      allTools.push(...enriched);
    }

    return allTools;
  }

  /**
   * Execute a tool call via mcp-use.
   * mcp-use handles JSON-RPC, error handling, response parsing.
   */
  async callTool(
    serverName: string,
    toolName: string,
    params: Record<string, unknown>
  ): Promise<any> {
    const session = await this.client.getOrCreateSession(serverName);
    return session.callTool(toolName, params);
  }

  async shutdown(): Promise<void> {
    await this.client.closeAllSessions();
  }
}
```

### 2. Context Analyzer

Determines which MCP tools are relevant for the current conversation. This is our differentiator — mcp-use doesn't do this.

```typescript
// src/context-analyzer.ts

interface RelevanceScore {
  tool: ToolWithServer;
  score: number;          // 0-1
  matchType: 'keyword' | 'category' | 'history' | 'semantic';
}

interface AnalyzerConfig {
  maxToolsPerTurn: number;          // default: 5
  relevanceThreshold: number;       // default: 0.3
  highConfidenceThreshold: number;  // default: 0.7 (auto-inject)
  recentToolBoost: number;          // default: 0.15
}

class ContextAnalyzer {
  private recentlyUsed: Map<string, number> = new Map(); // tool → timestamp

  /**
   * Score all available tools against current conversation context.
   *
   * Scoring layers (fast to slow, early exit if enough high-confidence matches):
   *
   * 1. KEYWORD MATCH (cheap, synchronous)
   *    - Extract nouns/verbs from last 3 messages
   *    - Match against tool names + descriptions
   *    - Score: jaccard similarity × 0.6
   *
   * 2. CATEGORY MATCH (cheap, synchronous)
   *    - Map conversation intent to categories
   *    - "create a page in notion" → ["productivity", "notes"]
   *    - Match against server categories from config
   *    - Score: category overlap × 0.3
   *
   * 3. HISTORY BOOST (cheap, synchronous)
   *    - Recently used tools get a small boost
   *    - Decays over time (last 5 min = full boost, then linear decay)
   *    - Score: recency factor × 0.15
   *
   * 4. INTENT KEYWORDS (predefined mappings)
   *    - "search" / "find" / "look up" → search-type tools
   *    - "create" / "make" / "add" → creation tools
   *    - "delete" / "remove" → destructive tools (lower threshold)
   *    - Score: intent match × 0.4
   */
  rank(
    messages: { role: string; content: string }[],
    allTools: ToolWithServer[],
    config: AnalyzerConfig
  ): RelevanceScore[] {
    // Implementation: layer scores, sort, return top N
  }

  /**
   * After a tool is successfully called, record it for history boost.
   */
  recordUsage(toolName: string, serverName: string): void {
    this.recentlyUsed.set(`${serverName}:${toolName}`, Date.now());
  }
}
```

### 3. Schema Compressor

Compresses MCP tool descriptions for minimal token usage.

```typescript
// src/schema-compressor.ts

interface CompressedTool {
  name: string;                 // e.g., "mcp_notion_create_page"
  shortDescription: string;     // max 80 chars
  requiredParams: ParamSpec[];  // only required ones
  optionalHint: string | null;  // "also accepts: format, tags, ..."
  _original: ToolWithServer;    // kept for execution
}

class SchemaCompressor {
  /**
   * Compress a tool spec for agent consumption.
   *
   * Before: ~350 tokens per tool
   * After:  ~60 tokens per tool
   *
   * Rules:
   * - Description: first sentence only, max 80 chars
   * - Params: only show required; list optional names as hint
   * - Name: prefix with mcp_{server}_ for clarity
   * - Type annotations: simplified (e.g., "string" not "string with pattern ...")
   */
  compress(tool: ToolWithServer): CompressedTool;

  /**
   * Expand back to full spec when agent actually calls the tool.
   */
  getOriginal(compressedName: string): ToolWithServer;
}
```

### 4. Result Cache

Cache read-only tool results to reduce latency.

```typescript
// src/result-cache.ts

interface CacheEntry {
  key: string;              // hash of server+tool+params
  result: any;
  timestamp: number;
  ttlMs: number;
}

class ResultCache {
  private cache = new Map<string, CacheEntry>();

  /**
   * Safe-to-cache heuristics:
   * - Tool name contains: list, get, search, read, fetch, describe
   * - Tool name does NOT contain: create, update, delete, send, post
   * - Configurable overrides in plugin config
   */
  isCacheable(toolName: string): boolean;

  get(server: string, tool: string, params: unknown): any | null;
  set(server: string, tool: string, params: unknown, result: any, ttlMs?: number): void;
  prune(): void;
}
```

### 5. Plugin Entry Point (OpenClaw integration)

```typescript
// src/index.ts
import type { PluginApi } from 'openclaw';
import { McpLayer } from './mcp-layer';
import { ContextAnalyzer } from './context-analyzer';
import { SchemaCompressor } from './schema-compressor';
import { ResultCache } from './result-cache';

export default function mcpBridge(api: PluginApi) {
  const mcpLayer = new McpLayer(api.config);
  const analyzer = new ContextAnalyzer();
  const compressor = new SchemaCompressor();
  const cache = new ResultCache();

  // ─── META-TOOL: On-demand tool discovery ───
  api.registerTool({
    name: 'mcp_find_tools',
    description: 'Find tools from connected services (Notion, GitHub, etc). Use when you need a capability not in your current tools.',
    parameters: {
      type: 'object',
      properties: {
        need: {
          type: 'string',
          description: 'What you need to do, e.g. "create a notion page"'
        }
      },
      required: ['need']
    },
    execute: async ({ need }, context) => {
      const allTools = await mcpLayer.discoverTools();
      const ranked = analyzer.rank(
        [{ role: 'user', content: need }],
        allTools,
        api.config.analyzer
      );

      const top = ranked
        .filter(r => r.score >= api.config.analyzer.relevanceThreshold)
        .slice(0, api.config.analyzer.maxToolsPerTurn);

      // Register matched tools as ephemeral agent tools
      for (const match of top) {
        const compressed = compressor.compress(match.tool);
        api.registerEphemeralTool({
          name: compressed.name,
          description: compressed.shortDescription,
          parameters: compressed.requiredParams,
          execute: async (params) => {
            // Check cache for read-only tools
            const cached = cache.get(match.tool.serverName, match.tool.name, params);
            if (cached) return cached;

            const result = await mcpLayer.callTool(
              match.tool.serverName,
              match.tool.name,
              params
            );

            analyzer.recordUsage(match.tool.name, match.tool.serverName);

            if (cache.isCacheable(match.tool.name)) {
              cache.set(match.tool.serverName, match.tool.name, params, result);
            }

            return result;
          }
        });
      }

      return {
        found: top.length,
        tools: top.map(t => `${t.tool.serverName}/${t.tool.name} (${Math.round(t.score * 100)}% match)`)
      };
    }
  });

  // ─── AUTO-INJECTION: High-confidence tool pre-loading ───
  api.onBeforeAgentTurn?.(async (context) => {
    const allTools = await mcpLayer.discoverTools();
    const ranked = analyzer.rank(
      context.messages,
      allTools,
      api.config.analyzer
    );

    // Only auto-inject when we're very confident
    const highConf = ranked
      .filter(r => r.score >= api.config.analyzer.highConfidenceThreshold)
      .slice(0, 3);

    for (const match of highConf) {
      const compressed = compressor.compress(match.tool);
      api.registerEphemeralTool({
        name: compressed.name,
        description: compressed.shortDescription,
        parameters: compressed.requiredParams,
        execute: async (params) => {
          const cached = cache.get(match.tool.serverName, match.tool.name, params);
          if (cached) return cached;

          const result = await mcpLayer.callTool(
            match.tool.serverName,
            match.tool.name,
            params
          );

          analyzer.recordUsage(match.tool.name, match.tool.serverName);

          if (cache.isCacheable(match.tool.name)) {
            cache.set(match.tool.serverName, match.tool.name, params, result);
          }

          return result;
        }
      });
    }
  });

  // ─── LIFECYCLE ───
  api.onShutdown(async () => {
    await mcpLayer.shutdown();
  });
}
```

---

## Plugin Manifest

```json
{
  "name": "openclaw-mcp-bridge",
  "version": "0.1.0",
  "description": "Context-aware MCP bridge for OpenClaw, powered by mcp-use",
  "main": "dist/index.js",
  "dependencies": {
    "mcp-use": "^latest"
  },
  "openclaw": {
    "extensions": [
      {
        "type": "tool",
        "id": "mcp-bridge",
        "entry": "dist/index.js"
      }
    ]
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "servers": {
        "type": "array",
        "description": "MCP servers to connect to",
        "items": {
          "type": "object",
          "required": ["name"],
          "properties": {
            "name": { "type": "string" },
            "transport": { "type": "string", "enum": ["stdio", "http", "sse"] },
            "command": { "type": "string" },
            "args": { "type": "array", "items": { "type": "string" } },
            "url": { "type": "string" },
            "env": { "type": "object" },
            "headers": { "type": "object" },
            "categories": {
              "type": "array",
              "items": { "type": "string" },
              "description": "Hint categories for relevance matching"
            }
          }
        }
      },
      "autoDiscover": {
        "type": "boolean",
        "default": true,
        "description": "Auto-detect servers from ~/.mcp.json"
      },
      "analyzer": {
        "type": "object",
        "properties": {
          "maxToolsPerTurn": { "type": "number", "default": 5 },
          "relevanceThreshold": { "type": "number", "default": 0.3 },
          "highConfidenceThreshold": { "type": "number", "default": 0.7 }
        }
      },
      "cache": {
        "type": "object",
        "properties": {
          "enabled": { "type": "boolean", "default": true },
          "ttlMs": { "type": "number", "default": 30000 }
        }
      }
    }
  },
  "uiHints": {
    "servers": { "label": "MCP Servers" },
    "autoDiscover": { "label": "Auto-discover from ~/.mcp.json" }
  }
}
```

---

## User Configuration

```json
// Minimal — auto-discover from existing ~/.mcp.json
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

```json
// Explicit servers
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
            }
          ],
          "analyzer": {
            "maxToolsPerTurn": 5,
            "relevanceThreshold": 0.3
          }
        }
      }
    }
  }
}
```

---

## Project Structure

```
openclaw-mcp-bridge/
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE (MIT)
├── src/
│   ├── index.ts              # OpenClaw plugin entry point
│   ├── mcp-layer.ts          # mcp-use MCPClient wrapper
│   ├── context-analyzer.ts   # Relevance scoring engine
│   ├── schema-compressor.ts  # Tool description compression
│   ├── result-cache.ts       # Response caching
│   ├── discovery.ts          # ~/.mcp.json auto-discovery
│   └── types.ts              # Shared types
├── tests/
│   ├── context-analyzer.test.ts
│   ├── schema-compressor.test.ts
│   ├── result-cache.test.ts
│   ├── mcp-layer.test.ts
│   └── fixtures/
│       └── tool-specs.json   # Sample tool specifications
└── examples/
    ├── minimal.json
    └── multi-server.json
```

---

## What mcp-use gives us for free

By building on mcp-use instead of raw `@modelcontextprotocol/sdk`:

| Concern | DIY | With mcp-use |
|---------|-----|-------------|
| Stdio process management | ~200 LOC | 0 LOC (MCPClient handles it) |
| HTTP/SSE transport | ~150 LOC | 0 LOC |
| JSON-RPC protocol | ~100 LOC | 0 LOC |
| Multi-server routing | ~100 LOC | `MCPClient.fromDict()` |
| Session lifecycle | ~80 LOC | Automatic |
| Error handling/retry | ~60 LOC | Built-in |
| **Total saved** | **~690 LOC** | **~0 LOC** |

This means our codebase is **~500 LOC** of pure intelligence:
- Context Analyzer: ~150 LOC
- Schema Compressor: ~80 LOC
- Result Cache: ~60 LOC
- mcp-use wrapper: ~80 LOC
- Plugin entry point: ~130 LOC

Small, focused, maintainable.

---

## Development Plan

### Phase 1 — MVP (Week 1)
**Goal**: Plugin connects to MCP servers via mcp-use, exposes `mcp_find_tools`.

- [ ] Scaffold project with mcp-use dependency
- [ ] `McpLayer` class wrapping `MCPClient.fromDict()`
- [ ] Auto-discovery from `~/.mcp.json`
- [ ] `mcp_find_tools` meta-tool (no filtering yet — expose all found tools)
- [ ] Basic tool execution via `session.callTool()`
- [ ] Test: install plugin in OpenClaw, call a real MCP server
- [ ] Verify: `openclaw plugins list` shows mcp-bridge loaded

**Deliverable**: Working plugin — install and call any MCP server from OpenClaw.

### Phase 2 — Intelligence (Week 2-3)
**Goal**: Context-aware filtering that justifies the plugin's existence.

- [ ] Context Analyzer (keyword + category + history scoring)
- [ ] Schema Compressor (description truncation, param hiding)
- [ ] Ephemeral tool registration per-turn
- [ ] `onBeforeAgentTurn` auto-injection for high-confidence matches
- [ ] Result caching for read-only tools
- [ ] Token usage tracking & benchmarks

**Deliverable**: Smart plugin that saves 70%+ tokens vs naive approach.

### Phase 3 — Ship It (Week 4)
**Goal**: Polished, documented, published.

- [ ] README with installation guide, benchmarks, examples
- [ ] Comprehensive test suite (unit + integration with mock MCP servers)
- [ ] Publish to npm as `openclaw-mcp-bridge`
- [ ] Submit to ClawHub skill registry
- [ ] Write blog post: "How we brought MCP to OpenClaw without the token tax"
- [ ] Post on OpenClaw Discord + GitHub Discussions

**Deliverable**: Public release.

### Phase 4 — Community (Ongoing)
- [ ] Gather feedback, iterate
- [ ] Explore upstream merge opportunity with OpenClaw maintainers
- [ ] Add semantic matching if community requests it
- [ ] Support MCP OAuth flows via mcp-use's capabilities

---

## Open Questions

1. **Ephemeral tool API**: Does OpenClaw's plugin system support registering tools dynamically mid-conversation? Need to verify in the plugin docs. Fallback: pre-register a fixed proxy tool that routes internally.

2. **`onBeforeAgentTurn` hook**: May not exist as documented. Alternative: use OpenClaw's `api.runtime` events or skill-based approach.

3. **mcp-use session lifecycle**: Verify that `MCPClient` supports lazy session creation (connect only when first tool from that server is needed, not at startup).

4. **Tool allowlisting**: OpenClaw sandbox requires tool allowlisting. Our dynamically registered tools need to be in the allowlist. Can we wildcard `mcp_*`?

5. **mcp-use TS version stability**: The TS SDK (`mcp-use` on npm) is newer than the Python one. Pin version carefully and watch for breaking changes.

---

## Why this wins

For the **OpenClaw community**: finally, proper MCP support without the token tax.
For **mcp-use**: a high-visibility integration (OpenClaw has 157k stars) that showcases the SDK.
For **us**: a focused ~500 LOC project that solves a real problem for a massive community.

---

*Built on mcp-use. MIT licensed.*
*Created by Gabriele — February 2026*
