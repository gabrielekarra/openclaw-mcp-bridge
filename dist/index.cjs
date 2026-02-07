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
    if (this.serverEntries.length === 0) return [];
    const client = this.getClient();
    const allTools = [];
    for (const serverName of client.getServerNames()) {
      const cached = this.toolCache.get(serverName);
      if (cached && !cached.isStale()) {
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
        allTools.push(...enriched);
      } catch (err) {
        console.warn(`[mcp-bridge] Failed to list tools from "${serverName}":`, err);
      }
    }
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
var Aggregator = class {
  constructor(config) {
    this.config = config;
    this.mcpLayer = new McpLayer(config);
    this.analyzer = new ContextAnalyzer();
    this.compressor = new SchemaCompressor();
    this.cache = new ResultCache(config.cache);
  }
  mcpLayer;
  analyzer;
  compressor;
  cache;
  /** Maps compressed name → { serverName, toolName } for routing */
  routeMap = /* @__PURE__ */ new Map();
  /** Discover tools from all downstream MCP servers and build route map */
  async refreshTools() {
    const tools = await this.mcpLayer.discoverTools();
    for (const tool of tools) {
      const compressed = this.compressor.compress(tool);
      this.routeMap.set(compressed.name, {
        serverName: tool.serverName,
        toolName: tool.name
      });
    }
  }
  /** Return all tools in MCP Tool shape (find_tools meta-tool + downstream tools) */
  getToolList() {
    const tools = [];
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
    for (const [compressedName] of this.routeMap) {
      const original = this.compressor.getOriginal(compressedName);
      if (!original) continue;
      const compressed = this.compressor.compress(original);
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
    if (name === "find_tools") {
      return this.handleFindTools(params);
    }
    const route = this.routeMap.get(name);
    if (!route) {
      throw new Error(`Unknown tool: ${name}`);
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
          toolName: tool.name
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
        toolName: match.tool.name
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
