import "./chunk-L4WKZ6WT.js";
import {
  Aggregator,
  CachedToolSet,
  ContextAnalyzer,
  McpLayer,
  ResultCache,
  SchemaCompressor,
  discoverFromMcpJson
} from "./chunk-FUXLSWUD.js";

// src/plugin/index.ts
var registeredTools = /* @__PURE__ */ new Set();
function mcpBridge(api) {
  const pluginConfig = api?.config ?? {};
  const config = {
    servers: Array.isArray(pluginConfig.servers) ? pluginConfig.servers : [],
    autoDiscover: pluginConfig.autoDiscover ?? true,
    analyzer: {
      maxToolsPerTurn: pluginConfig.analyzer?.maxToolsPerTurn ?? 5,
      relevanceThreshold: pluginConfig.analyzer?.relevanceThreshold ?? 0.3,
      highConfidenceThreshold: pluginConfig.analyzer?.highConfidenceThreshold ?? 0.7,
      recentToolBoost: pluginConfig.analyzer?.recentToolBoost ?? 0.15
    },
    cache: {
      enabled: pluginConfig.cache?.enabled ?? true,
      ttlMs: pluginConfig.cache?.ttlMs ?? 3e4,
      maxEntries: pluginConfig.cache?.maxEntries ?? 100
    }
  };
  const mcpLayer = new McpLayer(config);
  const analyzer = new ContextAnalyzer();
  const compressor = new SchemaCompressor();
  const cache = new ResultCache(config.cache);
  function registerCompressedTool(compressed) {
    if (registeredTools.has(compressed.name)) return;
    const desc = compressed.optionalHint ? `${compressed.shortDescription}. ${compressed.optionalHint}` : compressed.shortDescription;
    api.registerTool({
      name: compressed.name,
      description: desc,
      parameters: compressed.parameters,
      execute: async (params) => {
        const mapping = compressor.decompress(compressed.name, params ?? {});
        if (!mapping) return { error: `Unknown tool: ${compressed.name}` };
        try {
          const cached = cache.get(mapping.serverName, mapping.toolName, mapping.fullParams);
          if (cached) return cached;
          const result = await mcpLayer.callTool(mapping.serverName, mapping.toolName, mapping.fullParams);
          analyzer.recordUsage(mapping.toolName, mapping.serverName);
          if (cache.isCacheable(mapping.toolName)) {
            cache.set(mapping.serverName, mapping.toolName, mapping.fullParams, result);
          }
          return result;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: `Tool call failed: ${msg}` };
        }
      }
    });
    registeredTools.add(compressed.name);
  }
  api.registerTool({
    name: "mcp_find_tools",
    description: "Search and discover tools from external MCP servers. Call this when you need capabilities beyond your built-in tools. Examples: creating GitHub issues, searching Notion, managing databases, file operations. Returns a list of matching tools ranked by relevance. After discovering tools, you can call them directly by name.",
    parameters: {
      type: "object",
      properties: {
        need: {
          type: "string",
          description: 'What you need to accomplish. Example: "create a github issue", "search notion pages", "list database tables". Use empty string to list all available tools.'
        }
      },
      required: ["need"]
    },
    execute: async (params) => {
      const need = typeof params?.need === "string" ? params.need : "";
      let allTools;
      try {
        allTools = await mcpLayer.discoverTools();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[mcp-bridge] discovery failed in mcp_find_tools:", err);
        return { found: 0, tools: [], error: `Discovery failed: ${msg}` };
      }
      if (!Array.isArray(allTools) || allTools.length === 0) {
        return {
          found: 0,
          tools: [],
          hint: "No MCP servers found. Add servers to ~/.mcp.json or to plugin config."
        };
      }
      let ranked;
      try {
        ranked = analyzer.rank(
          [{ role: "user", content: need }],
          allTools,
          config.analyzer
        ) ?? [];
      } catch (err) {
        console.error("[mcp-bridge] ranking failed:", err);
        ranked = allTools.map((t) => ({ tool: t, score: 0.5, matchType: "keyword" }));
      }
      if (!Array.isArray(ranked)) ranked = [];
      const registered = [];
      for (const match of ranked) {
        const compressed = compressor.compress(match.tool);
        registerCompressedTool(compressed);
        registered.push(`${match.tool.serverName}/${match.tool.name} (${Math.round(match.score * 100)}%)`);
      }
      return {
        found: ranked.length,
        tools: registered,
        message: ranked.length > 0 ? `Found ${ranked.length} relevant tool(s). They are now available for use.` : `No tools matched "${need}". Try a broader description.`
      };
    }
  });
  api.registerTool({
    name: "mcp_list_servers",
    description: "List all connected MCP servers and their connection status. Use this to check which external tool providers are available.",
    parameters: {
      type: "object",
      properties: {}
    },
    execute: async () => {
      try {
        const servers = mcpLayer.getServerInfo();
        return {
          servers: servers.map((s) => ({
            name: s.name,
            transport: s.transport,
            status: s.connected ? "connected" : "disconnected",
            tools: s.toolCount
          })),
          total: servers.length
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { servers: [], total: 0, error: `Failed to list servers: ${msg}` };
      }
    }
  });
  api.onBeforeAgentTurn?.(async (context) => {
    try {
      const messages = Array.isArray(context?.messages) ? context.messages : [];
      if (messages.length === 0) return;
      const allTools = await mcpLayer.discoverTools();
      if (!Array.isArray(allTools) || allTools.length === 0) return;
      const threshold = config.analyzer?.highConfidenceThreshold ?? 0.7;
      const ranked = analyzer.rank(messages, allTools, {
        ...config.analyzer,
        relevanceThreshold: threshold,
        maxToolsPerTurn: 3
      });
      if (Array.isArray(ranked)) {
        for (const match of ranked) registerCompressedTool(compressor.compress(match.tool));
      }
    } catch {
    }
  });
  api.onShutdown?.(async () => {
    try {
      await mcpLayer.shutdown();
    } catch (err) {
      console.error("[mcp-bridge] shutdown error:", err);
    }
  });
}
export {
  Aggregator,
  CachedToolSet,
  ContextAnalyzer,
  McpLayer,
  ResultCache,
  SchemaCompressor,
  mcpBridge as default,
  discoverFromMcpJson
};
