import "./chunk-L4WKZ6WT.js";
import {
  Aggregator,
  CachedToolSet,
  ContextAnalyzer,
  McpLayer,
  ResultCache,
  SchemaCompressor,
  discoverFromMcpJson
} from "./chunk-ND5WNCG5.js";

// src/plugin/index.ts
var fallbackShutdownLayers = /* @__PURE__ */ new Set();
var fallbackShutdownHookRegistered = false;
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : null;
}
function parseRecordJson(value) {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}
function getCandidateRecords(params) {
  const root = parseRecordJson(params) ?? asRecord(params);
  if (!root) return [];
  const records = [root];
  const nestedKeys = ["input", "args", "parameters", "toolInput", "payload"];
  for (const key of nestedKeys) {
    const nested = parseRecordJson(root[key]) ?? asRecord(root[key]);
    if (nested) records.push(nested);
  }
  const parsedArguments = parseRecordJson(root.arguments);
  if (parsedArguments) records.push(parsedArguments);
  return records;
}
function hasNeedCandidate(value) {
  const records = getCandidateRecords(value);
  return records.some((record) => typeof record.need === "string");
}
function extractExecuteParams(incoming) {
  if (!Array.isArray(incoming) || incoming.length === 0) return void 0;
  if (incoming.length === 1) return incoming[0];
  const candidate = incoming.find(hasNeedCandidate);
  if (candidate !== void 0) return candidate;
  if (typeof incoming[0] === "string" && incoming.length > 1) return incoming[1];
  return incoming[0];
}
function extractGenericExecuteParams(incoming) {
  if (!Array.isArray(incoming) || incoming.length === 0) return void 0;
  if (incoming.length === 1) return incoming[0];
  if (typeof incoming[0] === "string" && incoming.length > 1) return incoming[1];
  return incoming[0];
}
function extractNeed(params) {
  if (typeof params === "string") {
    const parsed = parseRecordJson(params);
    if (!parsed) return params;
  }
  const records = getCandidateRecords(params);
  for (const record of records) {
    if (typeof record.need === "string") return record.need;
  }
  return "";
}
function pickFirstString(records, keys) {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") return value;
    }
  }
  return "";
}
function extractInlineArgs(record) {
  const reserved = /* @__PURE__ */ new Set([
    "server",
    "serverName",
    "tool",
    "toolName",
    "name",
    "input",
    "args",
    "parameters",
    "toolInput",
    "arguments",
    "params",
    "toolArgs",
    "payload"
  ]);
  return Object.entries(record).filter(([key]) => !reserved.has(key)).reduce((acc, [key, value]) => {
    acc[key] = value;
    return acc;
  }, {});
}
function extractToolCall(params) {
  const records = getCandidateRecords(params);
  if (records.length === 0) {
    return { serverName: "", toolName: "", toolParams: {} };
  }
  const callRecords = records.filter((record) => typeof record.server === "string" || typeof record.serverName === "string" || typeof record.tool === "string" || typeof record.toolName === "string");
  const callRecord = callRecords[0] ?? records[0];
  const serverName = pickFirstString([callRecord, ...callRecords], ["server", "serverName"]);
  const toolName = pickFirstString([callRecord, ...callRecords], ["tool", "toolName"]);
  const explicitArgs = parseRecordJson(callRecord.arguments) ?? asRecord(callRecord.arguments) ?? parseRecordJson(callRecord.params) ?? asRecord(callRecord.params) ?? parseRecordJson(callRecord.toolArgs) ?? asRecord(callRecord.toolArgs) ?? parseRecordJson(callRecord.args) ?? asRecord(callRecord.args) ?? parseRecordJson(callRecord.input) ?? asRecord(callRecord.input) ?? parseRecordJson(callRecord.parameters) ?? asRecord(callRecord.parameters) ?? parseRecordJson(callRecord.toolInput) ?? asRecord(callRecord.toolInput) ?? parseRecordJson(callRecord.payload) ?? asRecord(callRecord.payload);
  const toolParams = explicitArgs ?? extractInlineArgs(callRecord);
  return {
    serverName,
    toolName,
    toolParams: asRecord(toolParams) ?? {}
  };
}
var TRADITIONAL_WRAPPER_KEYS = /* @__PURE__ */ new Set([
  "arguments",
  "params",
  "toolArgs",
  "args",
  "input",
  "parameters",
  "toolInput",
  "payload"
]);
function extractSchemaProperties(schema) {
  const schemaRecord = asRecord(schema);
  const properties = asRecord(schemaRecord?.properties);
  if (!properties) return /* @__PURE__ */ new Set();
  return new Set(Object.keys(properties));
}
function extractSchemaRequired(schema) {
  const schemaRecord = asRecord(schema);
  const required = Array.isArray(schemaRecord?.required) ? schemaRecord.required.filter((entry) => typeof entry === "string") : [];
  return new Set(required);
}
function shouldUnwrapTraditionalParams(params) {
  if (params.schemaProperties.has(params.wrapperKey) || params.schemaRequired.has(params.wrapperKey)) {
    return false;
  }
  if (params.schemaRequired.size > 0) {
    return [...params.schemaRequired].every((key) => key in params.wrapped);
  }
  if (params.schemaProperties.size > 0) {
    return [...params.schemaProperties].some((key) => key in params.wrapped);
  }
  return params.wrapperKey === "arguments" || params.wrapperKey === "params" || params.wrapperKey === "toolArgs" || params.wrapperKey === "toolInput" || params.wrapperKey === "payload";
}
function extractWrappedToolParams(params, schema) {
  const root = parseRecordJson(params) ?? asRecord(params);
  if (!root) return {};
  const keys = Object.keys(root);
  if (keys.length !== 1) return root;
  const wrapperKey = keys[0];
  if (!TRADITIONAL_WRAPPER_KEYS.has(wrapperKey)) return root;
  const wrapped = parseRecordJson(root[wrapperKey]) ?? asRecord(root[wrapperKey]);
  if (!wrapped) return root;
  const schemaProperties = extractSchemaProperties(schema);
  const schemaRequired = extractSchemaRequired(schema);
  const shouldUnwrap = shouldUnwrapTraditionalParams({
    wrapperKey,
    wrapped,
    schemaProperties,
    schemaRequired
  });
  return shouldUnwrap ? wrapped : root;
}
function resolvePluginConfig(api) {
  const root = asRecord(api);
  const pluginConfig = asRecord(root?.pluginConfig);
  if (pluginConfig) return pluginConfig;
  const legacy = asRecord(root?.config);
  if (!legacy) return {};
  if ("servers" in legacy || "autoDiscover" in legacy || "analyzer" in legacy || "cache" in legacy || "mode" in legacy) {
    return legacy;
  }
  return {};
}
function resolveMode(value) {
  if (typeof value !== "string") return "smart";
  const normalized = value.trim().toLowerCase();
  return normalized === "traditional" ? "traditional" : "smart";
}
function toMessageList(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((entry) => {
    const record = asRecord(entry);
    return {
      role: typeof record?.role === "string" ? record.role : void 0,
      content: record?.content
    };
  });
}
function summarizeTool(tool, score) {
  const schema = asRecord(tool.inputSchema);
  const properties = asRecord(schema?.properties);
  const parameterNames = properties ? Object.keys(properties).slice(0, 8) : [];
  const required = Array.isArray(schema?.required) ? schema.required.filter((entry) => typeof entry === "string").slice(0, 8) : [];
  const summary = {
    name: tool.name,
    server: tool.serverName,
    description: (tool.description ?? "").slice(0, 120)
  };
  if (typeof score === "number") {
    summary.relevance = `${Math.round(score * 100)}%`;
  }
  if (parameterNames.length > 0) {
    summary.parameters = parameterNames;
  }
  if (required.length > 0) {
    summary.required = required;
  }
  return summary;
}
function sanitizeName(value) {
  return value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").toLowerCase();
}
function buildTraditionalToolName(tool, usedNames) {
  const base = `mcp_${sanitizeName(tool.serverName)}_${sanitizeName(tool.name)}`;
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }
  let suffix = 2;
  let candidate = `${base}_${suffix}`;
  while (usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${base}_${suffix}`;
  }
  usedNames.add(candidate);
  return candidate;
}
function registerListServersTool(api, mcpLayer) {
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
}
var SmartToolLoader = class {
  constructor(api, mcpLayer, config) {
    this.api = api;
    this.mcpLayer = mcpLayer;
    this.config = config;
    this.analyzer = new ContextAnalyzer();
    this.cache = new ResultCache(config.cache);
  }
  analyzer;
  cache;
  async init() {
    this.api.registerTool({
      name: "mcp_find_tools",
      description: 'Search for available tools from external MCP servers. Pass what you need in "need", or leave it empty to list all tools. Then call mcp_call_tool with the returned server and tool names.',
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
        let allTools = [];
        try {
          allTools = await this.mcpLayer.discoverTools();
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
          return {
            found: allTools.length,
            tools: allTools.slice(0, 20).map((tool) => summarizeTool(tool)),
            totalAvailable: allTools.length,
            hint: "Call mcp_call_tool with { server, tool, arguments }."
          };
        }
        let ranked;
        try {
          ranked = this.analyzer.rank(
            [{ role: "user", content: need }],
            allTools,
            this.config.analyzer
          ) ?? [];
        } catch (err) {
          console.error("[mcp-bridge] ranking failed:", err);
          ranked = allTools.map((tool) => ({ tool, score: 0.5, matchType: "keyword" }));
        }
        if (!Array.isArray(ranked)) ranked = [];
        const threshold = this.config.analyzer?.relevanceThreshold ?? 0.3;
        const maxTools = this.config.analyzer?.maxToolsPerTurn ?? 5;
        const filtered = ranked.filter((match) => typeof match?.score === "number" && match.score >= threshold).slice(0, maxTools);
        const tools = filtered.map((match) => summarizeTool(match.tool, match.score));
        return {
          found: tools.length,
          tools,
          hint: tools.length > 0 ? "Call mcp_call_tool with { server, tool, arguments }." : `No tools matched "${need}". Try a broader description.`
        };
      }
    });
    this.api.registerTool({
      name: "mcp_call_tool",
      description: "Call a downstream MCP tool discovered via mcp_find_tools. Provide the server name, tool name, and arguments object.",
      parameters: {
        type: "object",
        properties: {
          server: {
            type: "string",
            description: "Server name returned by mcp_find_tools."
          },
          tool: {
            type: "string",
            description: "Tool name returned by mcp_find_tools."
          },
          arguments: {
            type: "object",
            description: "Arguments to pass to the downstream tool.",
            additionalProperties: true
          }
        },
        required: ["server", "tool"]
      },
      execute: async (...incoming) => {
        const params = extractExecuteParams(incoming);
        const { serverName, toolName, toolParams } = extractToolCall(params);
        if (!serverName || !toolName) {
          return {
            error: "Missing required fields. Expected { server, tool, arguments }.",
            received: asRecord(params) ?? params
          };
        }
        try {
          const cached = this.cache.get(serverName, toolName, toolParams);
          if (cached !== null) return cached;
          const result = await this.mcpLayer.callTool(serverName, toolName, toolParams);
          this.analyzer.recordUsage(toolName, serverName);
          if (this.cache.isCacheable(toolName)) {
            this.cache.set(serverName, toolName, toolParams, result);
          }
          return result;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: `Tool call failed: ${msg}` };
        }
      }
    });
    registerListServersTool(this.api, this.mcpLayer);
  }
  async beforeAgentStart(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    await this.mcpLayer.discoverTools();
  }
  async shutdown() {
    await this.mcpLayer.shutdown();
  }
};
var TraditionalToolLoader = class {
  constructor(api, mcpLayer) {
    this.api = api;
    this.mcpLayer = mcpLayer;
  }
  registeredToolNames = /* @__PURE__ */ new Set();
  async init() {
    registerListServersTool(this.api, this.mcpLayer);
    let allTools = [];
    try {
      allTools = await this.mcpLayer.discoverTools();
    } catch (err) {
      console.error("[mcp-bridge] discovery failed in traditional mode:", err);
      return;
    }
    for (const tool of allTools) {
      this.registerTraditionalTool(tool);
    }
  }
  async shutdown() {
    await this.mcpLayer.shutdown();
  }
  registerTraditionalTool(tool) {
    const name = buildTraditionalToolName(tool, this.registeredToolNames);
    const description = tool.description?.trim() ? `${tool.description} (server: ${tool.serverName})` : `MCP tool ${tool.name} from ${tool.serverName}`;
    const parameters = asRecord(tool.inputSchema) ?? { type: "object", properties: {} };
    this.api.registerTool({
      name,
      description,
      parameters,
      execute: async (...incoming) => {
        const rawParams = extractGenericExecuteParams(incoming);
        const params = extractWrappedToolParams(rawParams, tool.inputSchema);
        try {
          return await this.mcpLayer.callTool(tool.serverName, tool.name, params);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: `Tool call failed: ${msg}` };
        }
      }
    });
  }
};
function createToolLoader(params) {
  if (params.mode === "traditional") {
    return new TraditionalToolLoader(params.api, params.mcpLayer);
  }
  return new SmartToolLoader(params.api, params.mcpLayer, params.config);
}
function registerShutdownFallback(layer) {
  fallbackShutdownLayers.add(layer);
  if (fallbackShutdownHookRegistered) return;
  fallbackShutdownHookRegistered = true;
  process.once("beforeExit", () => {
    for (const pendingLayer of fallbackShutdownLayers) {
      void pendingLayer.shutdown().catch(() => {
      });
    }
    fallbackShutdownLayers.clear();
  });
}
function registerLifecycleHooks(api, loader, mcpLayer, initPromise) {
  const hookApi = api;
  const runBeforeAgentStart = async (eventLike) => {
    if (typeof loader.beforeAgentStart !== "function") return;
    try {
      await initPromise;
      const eventRecord = asRecord(eventLike);
      const messages = toMessageList(eventRecord?.messages);
      await loader.beforeAgentStart(messages);
    } catch {
    }
  };
  const runShutdown = async () => {
    try {
      await initPromise;
    } catch {
    }
    try {
      await loader.shutdown();
    } catch (err) {
      console.error("[mcp-bridge] shutdown error (non-fatal):", err);
    }
  };
  if (typeof hookApi.on === "function") {
    hookApi.on("before_agent_start", runBeforeAgentStart);
    hookApi.on("gateway_stop", runShutdown);
    return;
  }
  if (typeof hookApi.onBeforeAgentTurn === "function") {
    hookApi.onBeforeAgentTurn(async (context) => {
      await runBeforeAgentStart(context);
    });
  }
  if (typeof hookApi.onShutdown === "function") {
    hookApi.onShutdown(runShutdown);
    return;
  }
  registerShutdownFallback(mcpLayer);
}
async function mcpBridge(api) {
  const pluginConfig = resolvePluginConfig(api);
  const mode = resolveMode(pluginConfig.mode);
  const analyzerConfig = asRecord(pluginConfig.analyzer);
  const cacheConfig = asRecord(pluginConfig.cache);
  const config = {
    servers: Array.isArray(pluginConfig.servers) ? pluginConfig.servers : [],
    autoDiscover: typeof pluginConfig.autoDiscover === "boolean" ? pluginConfig.autoDiscover : true,
    analyzer: {
      maxToolsPerTurn: typeof analyzerConfig?.maxToolsPerTurn === "number" ? analyzerConfig.maxToolsPerTurn : 5,
      relevanceThreshold: typeof analyzerConfig?.relevanceThreshold === "number" ? analyzerConfig.relevanceThreshold : 0.3,
      highConfidenceThreshold: typeof analyzerConfig?.highConfidenceThreshold === "number" ? analyzerConfig.highConfidenceThreshold : 0.7,
      recentToolBoost: typeof analyzerConfig?.recentToolBoost === "number" ? analyzerConfig.recentToolBoost : 0.15
    },
    cache: {
      enabled: typeof cacheConfig?.enabled === "boolean" ? cacheConfig.enabled : true,
      ttlMs: typeof cacheConfig?.ttlMs === "number" ? cacheConfig.ttlMs : 3e4,
      maxEntries: typeof cacheConfig?.maxEntries === "number" ? cacheConfig.maxEntries : 100
    }
  };
  const mcpLayer = new McpLayer(config);
  const loader = createToolLoader({ mode, api, mcpLayer, config });
  const initPromise = loader.init().catch((err) => {
    console.error(`[mcp-bridge] ${mode} mode initialization failed:`, err);
  });
  registerLifecycleHooks(api, loader, mcpLayer, initPromise);
  await initPromise;
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
