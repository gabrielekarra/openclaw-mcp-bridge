import "./chunk-L4WKZ6WT.js";
import {
  Aggregator,
  CachedToolSet,
  ContextAnalyzer,
  McpLayer,
  ResultCache,
  SchemaCompressor,
  discoverFromMcpJson
} from "./chunk-PICHJPLR.js";

// src/plugin/index.ts
var registeredTools = /* @__PURE__ */ new Set();
var fallbackShutdownLayers = /* @__PURE__ */ new Set();
var fallbackShutdownHookRegistered = false;
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : null;
}
function hasNeedCandidate(value) {
  const record = asRecord(value);
  if (!record) return false;
  if (typeof record.need === "string") return true;
  if (typeof asRecord(record.input)?.need === "string") return true;
  if (typeof asRecord(record.args)?.need === "string") return true;
  if (typeof asRecord(record.parameters)?.need === "string") return true;
  if (typeof asRecord(record.toolInput)?.need === "string") return true;
  const argumentRecord = parseRecordJson(record.arguments);
  return typeof argumentRecord?.need === "string";
}
function parseRecordJson(value) {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}
function extractNeed(params) {
  if (typeof params === "string") return params;
  const root = asRecord(params);
  const input = asRecord(root?.input);
  const args = asRecord(root?.args);
  const parameters = asRecord(root?.parameters);
  const toolInput = asRecord(root?.toolInput);
  const parsedArguments = parseRecordJson(root?.arguments);
  const candidate = root?.need ?? input?.need ?? parsedArguments?.need ?? args?.need ?? parameters?.need ?? toolInput?.need;
  return typeof candidate === "string" ? candidate : "";
}
function extractExecuteParams(incoming) {
  if (!Array.isArray(incoming) || incoming.length === 0) return void 0;
  if (incoming.length === 1) return incoming[0];
  const candidate = incoming.find(hasNeedCandidate);
  if (candidate !== void 0) return candidate;
  if (typeof incoming[0] === "string" && incoming.length > 1) return incoming[1];
  return incoming[0];
}
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
      execute: async (...incoming) => {
        const params = parseRecordJson(extractExecuteParams(incoming)) ?? {};
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
    description: "Search for available tools from external MCP servers. Call this to discover what tools you can use for a task. Pass a description of what you need, or leave empty to list all tools. After finding tools, you can call them directly by name.",
    parameters: {
      type: "object",
      properties: {
        need: {
          type: "string",
          description: 'What you need to do, e.g. "create a github issue" or "search notion". Leave empty to list all available tools.'
        }
      },
      required: []
    },
    execute: async (...incoming) => {
      const params = extractExecuteParams(incoming);
      const need = extractNeed(params);
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
      if (need.trim() === "") {
        const allCompressed = allTools.map((tool) => {
          registerCompressedTool(compressor.compress(tool));
          return {
            name: tool.name,
            server: tool.serverName,
            description: (tool.description ?? "").slice(0, 80)
          };
        });
        return {
          found: allCompressed.length,
          tools: allCompressed.slice(0, 20),
          totalAvailable: allCompressed.length,
          hint: 'Showing all tools. Pass a "need" parameter to filter by relevance.'
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
      const threshold = config.analyzer?.relevanceThreshold ?? 0.3;
      const maxTools = config.analyzer?.maxToolsPerTurn ?? 5;
      const filtered = ranked.filter((match) => typeof match?.score === "number" && match.score >= threshold).slice(0, maxTools);
      const registered = [];
      for (const match of filtered) {
        const compressed = compressor.compress(match.tool);
        registerCompressedTool(compressed);
        registered.push({
          name: match.tool.name,
          server: match.tool.serverName,
          relevance: `${Math.round(match.score * 100)}%`,
          description: (match.tool.description ?? "").slice(0, 80)
        });
      }
      return {
        found: registered.length,
        tools: registered,
        hint: registered.length > 0 ? "Call any tool by name." : `No tools matched "${need}". Try a broader description.`
      };
    }
  });
  api.registerTool({
    name: "mcp_list_servers",
    description: "List all connected MCP servers and how many tools each provides. Use this to check what external tool servers are available.",
    parameters: {
      type: "object",
      properties: {}
    },
    execute: async () => {
      try {
        const serverNames = mcpLayer.getServerNames();
        if (serverNames.length === 0) {
          return { servers: [], total: 0, hint: "No MCP servers configured." };
        }
        let tools = [];
        try {
          tools = await mcpLayer.discoverTools();
        } catch {
        }
        const servers = serverNames.map((name) => {
          const serverTools = tools.filter((t) => t.serverName === name);
          return {
            name,
            tools: serverTools.length,
            sampleTools: serverTools.slice(0, 5).map((t) => t.name)
          };
        });
        return {
          servers,
          total: servers.length,
          totalTools: tools.length
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
  if (typeof api.onShutdown === "function") {
    api.onShutdown(async () => {
      try {
        await mcpLayer.shutdown();
      } catch (err) {
        console.error("[mcp-bridge] shutdown error (non-fatal):", err);
      }
    });
  } else {
    console.log("[mcp-bridge] api.onShutdown not available, using process.beforeExit fallback");
    fallbackShutdownLayers.add(mcpLayer);
    if (!fallbackShutdownHookRegistered) {
      fallbackShutdownHookRegistered = true;
      process.once("beforeExit", () => {
        for (const layer of fallbackShutdownLayers) {
          void layer.shutdown().catch(() => {
          });
        }
        fallbackShutdownLayers.clear();
      });
    }
  }
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
