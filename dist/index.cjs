"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  Aggregator: () => Aggregator,
  CachedToolSet: () => CachedToolSet,
  ContextAnalyzer: () => ContextAnalyzer,
  McpLayer: () => McpLayer,
  ResultCache: () => ResultCache,
  SchemaCompressor: () => SchemaCompressor,
  default: () => mcpBridge,
  discoverFromMcpJson: () => discoverFromMcpJson
});
module.exports = __toCommonJS(index_exports);

// src/core/mcp-layer.ts
var import_mcp_use = require("mcp-use");

// src/core/discovery.ts
var import_node_fs = require("fs");
var import_node_path = require("path");
var import_node_os = require("os");
function discoverFromMcpJson(path) {
  const configPath = path ?? (0, import_node_path.join)((0, import_node_os.homedir)(), ".mcp.json");
  let raw;
  try {
    raw = (0, import_node_fs.readFileSync)(configPath, "utf-8");
  } catch {
    return [];
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    return [];
  }
  const servers = [];
  for (const [name, entry] of Object.entries(config.mcpServers)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.command) {
      servers.push({
        name,
        transport: "stdio",
        command: entry.command,
        args: entry.args,
        env: entry.env
      });
    } else if (entry.url) {
      servers.push({
        name,
        transport: entry.url.includes("/sse") ? "sse" : "http",
        url: entry.url,
        headers: entry.headers
      });
    }
  }
  return servers;
}

// src/core/types.ts
var CachedToolSet = class _CachedToolSet {
  tools;
  timestamp;
  static TTL_MS = 5 * 60 * 1e3;
  // 5 minutes
  constructor(tools) {
    this.tools = tools;
    this.timestamp = Date.now();
  }
  isStale() {
    return Date.now() - this.timestamp > _CachedToolSet.TTL_MS;
  }
};

// src/core/mcp-layer.ts
var McpLayer = class {
  constructor(config) {
    this.config = config;
    const explicit = config.servers ?? [];
    const discovered = config.autoDiscover !== false ? discoverFromMcpJson() : [];
    const byName = /* @__PURE__ */ new Map();
    for (const s of discovered) byName.set(s.name, s);
    for (const s of explicit) byName.set(s.name, s);
    this.serverEntries = [...byName.values()];
  }
  client = null;
  toolCache = /* @__PURE__ */ new Map();
  serverEntries;
  lastSuccessfulServers = /* @__PURE__ */ new Set();
  lastFailedServers = /* @__PURE__ */ new Set();
  /** Convert our config to mcp-use's expected format and lazily create client */
  getClient() {
    if (this.client) return this.client;
    const mcpServers = {};
    for (const server of this.serverEntries) {
      if (server.transport === "stdio" && server.command) {
        mcpServers[server.name] = {
          command: server.command,
          args: server.args ?? [],
          env: server.env
        };
      } else if (server.url) {
        mcpServers[server.name] = {
          url: server.url,
          headers: server.headers
        };
      }
    }
    this.client = import_mcp_use.MCPClient.fromDict({ mcpServers });
    return this.client;
  }
  /** Get the categories configured for a server */
  getServerCategories(serverName) {
    return this.serverEntries.find((s) => s.name === serverName)?.categories ?? [];
  }
  /** Ensure a session exists for the given server, creating one if needed */
  async ensureSession(client, serverName) {
    const existing = client.getSession(serverName);
    if (existing) return existing;
    return client.createSession(serverName);
  }
  /** Discover all tools from all configured MCP servers */
  async discoverTools() {
    if (this.serverEntries.length === 0) {
      this.lastSuccessfulServers.clear();
      this.lastFailedServers.clear();
      return [];
    }
    const client = this.getClient();
    const allTools = [];
    const successfulServers = /* @__PURE__ */ new Set();
    const failedServers = /* @__PURE__ */ new Set();
    for (const serverName of client.getServerNames()) {
      const cached = this.toolCache.get(serverName);
      if (cached && !cached.isStale()) {
        successfulServers.add(serverName);
        allTools.push(...cached.tools);
        continue;
      }
      try {
        const session = await this.ensureSession(client, serverName);
        const rawTools = await session.listTools();
        const tools = Array.isArray(rawTools) ? rawTools : [];
        const enriched = tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          serverName,
          categories: this.getServerCategories(serverName)
        }));
        this.toolCache.set(serverName, new CachedToolSet(enriched));
        successfulServers.add(serverName);
        allTools.push(...enriched);
      } catch (err) {
        failedServers.add(serverName);
        console.warn(`[mcp-bridge] Failed to list tools from "${serverName}":`, err);
      }
    }
    this.lastSuccessfulServers = successfulServers;
    this.lastFailedServers = failedServers;
    return allTools;
  }
  /** Execute a tool call on a specific server */
  async callTool(serverName, toolName, params) {
    const client = this.getClient();
    const session = await this.ensureSession(client, serverName);
    return session.callTool(toolName, params);
  }
  /** Shut down all MCP connections */
  async shutdown() {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.toolCache.clear();
  }
  /** Get configured server names (for diagnostics) */
  getServerNames() {
    return this.serverEntries.map((s) => s.name);
  }
  /** Get status for the most recent discovery pass */
  getLastDiscoveryStatus() {
    return {
      successfulServers: [...this.lastSuccessfulServers],
      failedServers: [...this.lastFailedServers]
    };
  }
  /** Get info about all configured servers and their connection/tool state */
  getServerInfo() {
    return this.serverEntries.map((s) => ({
      name: s.name,
      transport: s.transport,
      connected: this.client !== null && this.client.getSession(s.name) !== null,
      toolCount: this.toolCache.get(s.name)?.tools.length ?? 0
    }));
  }
};

// src/core/context-analyzer.ts
var STOPWORDS = new Set("the a an is are was were be been being have has had do does did will would could should may might shall can need dare ought used to of in for on with at by from as into through during before after above below between out off over under again further then once here there when where why how all both each few more most other some such no nor not only own same so than too very just because but and or if while that this it i me my you your we our they them their what which who whom please want help make let get put also back still".split(" "));
var INTENT_CATEGORIES = [
  [/\b(note|notes|page|doc|document|write|draft)\b/i, ["productivity", "notes", "docs"]],
  [/\b(code|repo|repository|commit|pr|pull|merge|branch|issue|bug)\b/i, ["code", "dev", "repos", "issues"]],
  [/\b(pay|payment|invoice|billing|charge|subscription|customer)\b/i, ["payments", "billing", "finance"]],
  [/\b(file|folder|directory|path|read|upload|download)\b/i, ["filesystem", "files", "storage"]],
  [/\b(search|find|query|lookup|browse)\b/i, ["search", "discovery"]],
  [/\b(email|mail|message|send|notify|notification)\b/i, ["communication", "email", "messaging"]],
  [/\b(calendar|schedule|event|meeting|appointment)\b/i, ["calendar", "scheduling"]],
  [/\b(database|db|table|record|row|column|sql)\b/i, ["database", "data"]],
  [/\b(image|photo|picture|screenshot|media|video)\b/i, ["media", "images"]],
  [/\b(deploy|build|ci|cd|pipeline|release)\b/i, ["devops", "deployment"]]
];
var SEARCH_VERBS = new Set("search find look query list get fetch show browse check".split(" "));
var CREATE_VERBS = new Set("create make add new generate build write compose draft".split(" "));
var UPDATE_VERBS = new Set("update edit modify change set rename move".split(" "));
var DELETE_VERBS = new Set("delete remove clear drop destroy cancel".split(" "));
var INTENT_TOOL_PATTERNS = [
  [SEARCH_VERBS, /\b(search|list|get|find|query|fetch|show|browse|check|describe|read)\b/i],
  [CREATE_VERBS, /\b(create|add|new|make|generate|build|write|compose|insert)\b/i],
  [UPDATE_VERBS, /\b(update|edit|modify|change|set|rename|move|patch)\b/i],
  [DELETE_VERBS, /\b(delete|remove|clear|drop|destroy|cancel)\b/i]
];
function splitToolName(name) {
  if (typeof name !== "string" || name.trim() === "") return [];
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-]+/g, " ").toLowerCase().split(/\s+/).filter((w) => w.length > 0);
}
function extractWords(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}
function normalizeCategories(categories) {
  if (!Array.isArray(categories)) return [];
  return categories.filter((cat) => typeof cat === "string");
}
var ContextAnalyzer = class {
  recentlyUsed = /* @__PURE__ */ new Map();
  rank(messages, allTools, config) {
    if (!Array.isArray(allTools) || allTools.length === 0) return [];
    const maxTools = Math.max(1, config?.maxToolsPerTurn ?? 5);
    const threshold = Number.isFinite(config?.relevanceThreshold) ? Number(config?.relevanceThreshold) : 0.3;
    const userMsgs = Array.isArray(messages) ? messages.filter((m) => m?.role === "user").slice(-3) : [];
    if (userMsgs.length === 0) return [];
    const messageText = userMsgs.map((m) => typeof m.content === "string" ? m.content : "").join(" ").trim();
    if (messageText === "") {
      return allTools.map((tool) => ({ tool, score: 0.5, matchType: "keyword" })).slice(0, maxTools);
    }
    const words = extractWords(messageText);
    if (words.length === 0) {
      return allTools.map((tool) => ({ tool, score: 0.5, matchType: "keyword" })).slice(0, maxTools);
    }
    const scores = [];
    for (const tool of allTools) {
      const kw = this.scoreKeyword(words, tool);
      const cat = this.scoreCategory(messageText, tool);
      const int = this.scoreIntent(words, tool);
      const hist = this.scoreHistory(tool);
      const score = kw * 0.4 + cat * 0.3 + int * 0.2 + hist * 0.1;
      const layers = [
        { type: "keyword", val: kw },
        { type: "category", val: cat },
        { type: "intent", val: int },
        { type: "history", val: hist }
      ];
      const matchType = layers.sort((a, b) => b.val - a.val)[0].type;
      if (score >= threshold) scores.push({ tool, score, matchType });
    }
    return scores.sort((a, b) => b.score - a.score).slice(0, maxTools);
  }
  scoreKeyword(words, tool) {
    if (!Array.isArray(words) || words.length === 0) return 0;
    const toolWords = /* @__PURE__ */ new Set([
      ...splitToolName(tool?.name ?? ""),
      ...extractWords(typeof tool?.description === "string" ? tool.description : "")
    ]);
    if (toolWords.size === 0 || words.length === 0) return 0;
    let matched = 0;
    for (const w of words) {
      for (const tw of toolWords) {
        if (tw.includes(w) || w.includes(tw)) {
          matched++;
          break;
        }
      }
    }
    return matched / words.length;
  }
  scoreCategory(messageText, tool) {
    const categories = normalizeCategories(tool?.categories);
    if (categories.length === 0) return 0;
    const cats = /* @__PURE__ */ new Set();
    for (const [pat, c] of INTENT_CATEGORIES) if (pat.test(messageText)) c.forEach((x) => cats.add(x));
    if (cats.size === 0) return 0;
    let overlap = 0;
    for (const c of categories) if (cats.has(c.toLowerCase())) overlap++;
    return overlap / categories.length;
  }
  scoreIntent(words, tool) {
    if (!Array.isArray(words) || words.length === 0) return 0;
    const toolText = `${tool?.name ?? ""} ${typeof tool?.description === "string" ? tool.description : ""}`;
    for (const [verbs, pat] of INTENT_TOOL_PATTERNS) {
      if (words.some((w) => verbs.has(w)) && pat.test(toolText)) return 1;
    }
    return 0;
  }
  scoreHistory(tool) {
    const lastUsed = this.recentlyUsed.get(`${tool.serverName}:${tool.name}`);
    if (!lastUsed) return 0;
    const mins = (Date.now() - lastUsed) / 6e4;
    return mins > 30 ? 0 : Math.max(0, 1 - mins / 30);
  }
  recordUsage(toolName, serverName) {
    this.recentlyUsed.set(`${serverName}:${toolName}`, Date.now());
    const cutoff = Date.now() - 30 * 6e4;
    for (const [k, ts] of this.recentlyUsed) if (ts < cutoff) this.recentlyUsed.delete(k);
  }
};

// src/core/result-cache.ts
var CACHEABLE_PATTERNS = /(?:^|[_\s\-])(list|get|search|read|fetch|describe|show|find|query|status|info|check)(?:$|[_\s\-])/i;
var MUTATING_PATTERNS = /(?:^|[_\s\-])(create|update|delete|send|post|put|patch|remove|add|set|modify|write|execute|run|trigger)(?:$|[_\s\-])/i;
var ResultCache = class {
  cache = /* @__PURE__ */ new Map();
  defaultTtl;
  maxEntries;
  enabled;
  constructor(config) {
    this.enabled = config?.enabled ?? true;
    this.defaultTtl = config?.ttlMs ?? 3e4;
    this.maxEntries = config?.maxEntries ?? 100;
  }
  /** Check if a tool's results are safe to cache */
  isCacheable(toolName) {
    if (!this.enabled) return false;
    if (MUTATING_PATTERNS.test(toolName)) return false;
    return CACHEABLE_PATTERNS.test(toolName);
  }
  /** Get cached result, or null if miss/expired */
  get(server, tool, params) {
    if (!this.enabled) return null;
    const key = this.makeKey(server, tool, params);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > entry.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.result;
  }
  /** Store a result in cache */
  set(server, tool, params, result, ttlMs) {
    if (!this.enabled) return;
    const key = this.makeKey(server, tool, params);
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      this.evictOldest();
    }
    this.cache.set(key, {
      key,
      result,
      timestamp: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtl
    });
  }
  /** Remove all expired entries */
  prune() {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > entry.ttlMs) {
        this.cache.delete(key);
      }
    }
  }
  /** Current cache size (for testing) */
  get size() {
    return this.cache.size;
  }
  makeKey(server, tool, params) {
    const sortedParams = JSON.stringify(params, Object.keys(params ?? {}).sort());
    return JSON.stringify([server, tool, sortedParams]);
  }
  evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.cache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }
    if (oldestKey) this.cache.delete(oldestKey);
  }
};

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

// src/core/schema-compressor.ts
function makeCompressedName(serverName, toolName) {
  const sanitize = (s) => s.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").toLowerCase();
  return `mcp_${sanitize(serverName)}_${sanitize(toolName)}`;
}
function truncateDescription(desc, max) {
  const sentenceEnd = desc.search(/[.\n?]/);
  let text = sentenceEnd > 0 ? desc.slice(0, sentenceEnd) : desc;
  text = text.trim();
  if (text.length <= max) return text;
  const truncated = text.slice(0, max - 1);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > max / 2 ? truncated.slice(0, lastSpace) : truncated).trimEnd() + "\u2026";
}
function truncatePropDesc(desc, max = 60) {
  if (desc.length <= max) return desc;
  const truncated = desc.slice(0, max - 1);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > max / 2 ? truncated.slice(0, lastSpace) : truncated).trimEnd() + "\u2026";
}
var SchemaCompressor = class {
  originals = /* @__PURE__ */ new Map();
  /** Compress a tool spec for minimal token usage */
  compress(tool) {
    const name = makeCompressedName(tool.serverName, tool.name);
    this.originals.set(name, tool);
    const shortDescription = truncateDescription(
      tool.description ?? `${tool.serverName}/${tool.name}`,
      80
    );
    const schema = tool.inputSchema ?? {};
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const allParamNames = Object.keys(properties);
    const optionalNames = allParamNames.filter((p) => !required.has(p));
    const compressedProps = {};
    for (const paramName of allParamNames) {
      if (!required.has(paramName)) continue;
      const prop = { ...properties[paramName] };
      if (prop.description) {
        prop.description = truncatePropDesc(prop.description);
      }
      delete prop.examples;
      delete prop.pattern;
      delete prop.default;
      compressedProps[paramName] = prop;
    }
    const parameters = {
      type: "object",
      properties: compressedProps,
      ...required.size > 0 ? { required: [...required] } : {}
    };
    const optionalHint = optionalNames.length > 0 ? `Also accepts: ${optionalNames.join(", ")}` : null;
    return { name, shortDescription, parameters, optionalHint, _originalTool: tool };
  }
  /** Look up original tool by compressed name */
  getOriginal(compressedName) {
    return this.originals.get(compressedName);
  }
  /** Decompress: map compressed name back to server/tool for execution */
  decompress(compressedName, params) {
    const original = this.originals.get(compressedName);
    if (!original) return void 0;
    return {
      serverName: original.serverName,
      toolName: original.name,
      fullParams: params
      // pass through — agent may include optional params
    };
  }
};

// src/core/aggregator.ts
function asRecord2(value) {
  return typeof value === "object" && value !== null ? value : null;
}
function parseRecordJson2(value) {
  if (typeof value !== "string") return asRecord2(value);
  try {
    return asRecord2(JSON.parse(value));
  } catch {
    return null;
  }
}
function extractNeed2(params) {
  if (typeof params === "string") return params;
  const root = asRecord2(params);
  const input = asRecord2(root?.input);
  const args = asRecord2(root?.args);
  const parameters = asRecord2(root?.parameters);
  const toolInput = asRecord2(root?.toolInput);
  const parsedArguments = parseRecordJson2(root?.arguments);
  const candidate = root?.need ?? input?.need ?? parsedArguments?.need ?? args?.need ?? parameters?.need ?? toolInput?.need;
  return typeof candidate === "string" ? candidate : "";
}
function sanitizeName2(value) {
  return value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").toLowerCase();
}
function buildTraditionalToolName2(tool, usedNames) {
  const base = `mcp_${sanitizeName2(tool.serverName)}_${sanitizeName2(tool.name)}`;
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
var Aggregator = class {
  constructor(config) {
    this.config = config;
    this.mcpLayer = new McpLayer(config);
    this.analyzer = new ContextAnalyzer();
    this.compressor = new SchemaCompressor();
    this.cache = new ResultCache(config.cache);
    this.mode = config.mode === "traditional" ? "traditional" : "smart";
  }
  mcpLayer;
  analyzer;
  compressor;
  cache;
  mode;
  /** Maps compressed name → { serverName, toolName } for routing */
  routeMap = /* @__PURE__ */ new Map();
  /** Discover tools from all downstream MCP servers and build route map */
  async refreshTools() {
    const tools = await this.mcpLayer.discoverTools();
    const failedServers = new Set(this.mcpLayer.getLastDiscoveryStatus().failedServers);
    const nextRouteMap = /* @__PURE__ */ new Map();
    if (this.mode === "traditional") {
      const usedNames = /* @__PURE__ */ new Set();
      if (failedServers.size > 0) {
        for (const [name, route] of this.routeMap) {
          if (!failedServers.has(route.serverName)) continue;
          nextRouteMap.set(name, route);
          usedNames.add(name);
        }
      }
      for (const tool of tools) {
        const name = buildTraditionalToolName2(tool, usedNames);
        nextRouteMap.set(name, {
          serverName: tool.serverName,
          toolName: tool.name,
          tool
        });
      }
      this.routeMap = nextRouteMap;
      return;
    }
    for (const tool of tools) {
      const compressed = this.compressor.compress(tool);
      nextRouteMap.set(compressed.name, {
        serverName: tool.serverName,
        toolName: tool.name,
        tool
      });
    }
    if (failedServers.size > 0) {
      for (const [name, route] of this.routeMap) {
        if (!failedServers.has(route.serverName)) continue;
        if (!nextRouteMap.has(name)) {
          nextRouteMap.set(name, route);
        }
      }
    }
    this.routeMap = nextRouteMap;
  }
  /** Return tools in MCP Tool shape for the active mode */
  getToolList() {
    const tools = [];
    if (this.mode === "traditional") {
      for (const [name, route] of this.routeMap) {
        tools.push({
          name,
          description: route.tool.description ?? `${route.serverName}/${route.toolName}`,
          inputSchema: route.tool.inputSchema ?? { type: "object", properties: {} }
        });
      }
      return tools;
    }
    tools.push({
      name: "find_tools",
      description: "Search and discover tools from external MCP servers. Call this when you need capabilities beyond your built-in tools. Examples: creating GitHub issues, searching Notion, managing databases, file operations. Returns a list of matching tools ranked by relevance.",
      inputSchema: {
        type: "object",
        properties: {
          need: { type: "string", description: 'What you need to accomplish. Example: "create a github issue", "search notion pages". Use empty string to list all available tools.' }
        },
        required: []
      }
    });
    for (const [compressedName, route] of this.routeMap) {
      const compressed = this.compressor.compress(route.tool);
      const desc = compressed.optionalHint ? `${compressed.shortDescription}. ${compressed.optionalHint}` : compressed.shortDescription;
      tools.push({
        name: compressed.name,
        description: desc,
        inputSchema: compressed.parameters
      });
    }
    return tools;
  }
  /** Call a tool by name (handles find_tools meta-tool and downstream routing) */
  async callTool(name, params) {
    if (this.mode === "smart" && name === "find_tools") {
      return this.handleFindTools(params);
    }
    const route = this.routeMap.get(name);
    if (!route) {
      throw new Error(`Unknown tool: ${name}`);
    }
    if (this.mode === "traditional") {
      const result2 = await this.mcpLayer.callTool(route.serverName, route.toolName, params);
      return result2;
    }
    const cached = this.cache.get(route.serverName, route.toolName, params);
    if (cached) {
      return cached;
    }
    const result = await this.mcpLayer.callTool(route.serverName, route.toolName, params);
    this.analyzer.recordUsage(route.toolName, route.serverName);
    if (this.cache.isCacheable(route.toolName)) {
      this.cache.set(route.serverName, route.toolName, params, result);
    }
    return result;
  }
  /** Shut down all downstream MCP connections */
  async shutdown() {
    await this.mcpLayer.shutdown();
  }
  async handleFindTools(params) {
    const need = extractNeed2(params);
    let allTools = [];
    try {
      allTools = await this.mcpLayer.discoverTools();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: JSON.stringify({ found: 0, tools: [], error: `Discovery failed: ${msg}` }) }]
      };
    }
    if (!Array.isArray(allTools) || allTools.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ found: 0, tools: [], message: "No MCP servers configured or no tools available." }) }]
      };
    }
    if (need.trim() === "") {
      for (const tool of allTools) {
        const compressed = this.compressor.compress(tool);
        this.routeMap.set(compressed.name, {
          serverName: tool.serverName,
          toolName: tool.name,
          tool
        });
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            found: allTools.length,
            totalAvailable: allTools.length,
            tools: allTools.slice(0, 20).map((t) => ({
              name: t.name,
              server: t.serverName,
              description: (t.description ?? "").slice(0, 80)
            })),
            hint: 'Showing all tools. Pass a "need" parameter to filter by relevance.'
          })
        }]
      };
    }
    let ranked = [];
    try {
      ranked = this.analyzer.rank(
        [{ role: "user", content: need }],
        allTools,
        this.config.analyzer
      ) ?? [];
    } catch {
      ranked = allTools.map((t) => ({ tool: t, score: 0.5, matchType: "keyword" }));
    }
    if (!Array.isArray(ranked)) ranked = [];
    const threshold = this.config.analyzer?.relevanceThreshold ?? 0.3;
    const maxTools = this.config.analyzer?.maxToolsPerTurn ?? 5;
    const filtered = ranked.filter((r) => typeof r?.score === "number" && r.score >= threshold).slice(0, maxTools);
    for (const match of filtered) {
      const compressed = this.compressor.compress(match.tool);
      this.routeMap.set(compressed.name, {
        serverName: match.tool.serverName,
        toolName: match.tool.name,
        tool: match.tool
      });
    }
    const toolNames = filtered.map((m) => ({
      name: m.tool.name,
      server: m.tool.serverName,
      relevance: `${Math.round(m.score * 100)}%`,
      description: (m.tool.description ?? "").slice(0, 80)
    }));
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          found: toolNames.length,
          tools: toolNames,
          hint: toolNames.length > 0 ? "Call any tool by name." : `No tools matched "${need}". Try rephrasing your request.`
        })
      }]
    };
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Aggregator,
  CachedToolSet,
  ContextAnalyzer,
  McpLayer,
  ResultCache,
  SchemaCompressor,
  discoverFromMcpJson
});
