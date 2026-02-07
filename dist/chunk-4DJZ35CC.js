// src/core/discovery.ts
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
function discoverFromMcpJson(path) {
  const configPath = path ?? join(homedir(), ".mcp.json");
  let raw;
  try {
    raw = readFileSync(configPath, "utf-8");
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
import { MCPClient } from "mcp-use";
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
    this.client = MCPClient.fromDict({ mcpServers });
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
        const name = buildTraditionalToolName(tool, usedNames);
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
    const need = extractNeed(params);
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
      const listedTools = [];
      for (let i = 0; i < allTools.length; i += 1) {
        const tool = allTools[i];
        const compressed = this.compressor.compress(tool);
        this.routeMap.set(compressed.name, {
          serverName: tool.serverName,
          toolName: tool.name,
          tool
        });
        if (i < 20) {
          listedTools.push({
            name: tool.name,
            server: tool.serverName,
            callableName: compressed.name,
            description: (tool.description ?? "").slice(0, 80)
          });
        }
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            found: allTools.length,
            totalAvailable: allTools.length,
            tools: listedTools,
            hint: 'Showing all tools. Call by "callableName" (format: mcp_<server>_<tool>). Pass "need" to filter by relevance.'
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
    const toolNames = filtered.map((m) => {
      const compressed = this.compressor.compress(m.tool);
      this.routeMap.set(compressed.name, {
        serverName: m.tool.serverName,
        toolName: m.tool.name,
        tool: m.tool
      });
      return {
        name: m.tool.name,
        server: m.tool.serverName,
        callableName: compressed.name,
        relevance: `${Math.round(m.score * 100)}%`,
        description: (m.tool.description ?? "").slice(0, 80)
      };
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          found: toolNames.length,
          tools: toolNames,
          hint: toolNames.length > 0 ? 'Call a returned tool by its "callableName" (format: mcp_<server>_<tool>).' : `No tools matched "${need}". Try rephrasing your request.`
        })
      }]
    };
  }
};

export {
  discoverFromMcpJson,
  CachedToolSet,
  McpLayer,
  ContextAnalyzer,
  ResultCache,
  SchemaCompressor,
  Aggregator
};
