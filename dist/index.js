// src/mcp-layer.ts
import { MCPClient } from "mcp-use";

// src/discovery.ts
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

// src/types.ts
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

// src/mcp-layer.ts
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
        const tools = await session.listTools();
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
};

// src/context-analyzer.ts
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
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-]+/g, " ").toLowerCase().split(/\s+/).filter((w) => w.length > 0);
}
function extractWords(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}
var ContextAnalyzer = class {
  recentlyUsed = /* @__PURE__ */ new Map();
  rank(messages, allTools, config) {
    const maxTools = config?.maxToolsPerTurn ?? 5;
    const threshold = config?.relevanceThreshold ?? 0.3;
    const userMsgs = messages.filter((m) => m.role === "user").slice(-3);
    if (userMsgs.length === 0) return [];
    const messageText = userMsgs.map((m) => m.content).join(" ");
    const words = extractWords(messageText);
    if (words.length === 0) return [];
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
    const toolWords = /* @__PURE__ */ new Set([...splitToolName(tool.name), ...extractWords(tool.description ?? "")]);
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
    if (tool.categories.length === 0) return 0;
    const cats = /* @__PURE__ */ new Set();
    for (const [pat, c] of INTENT_CATEGORIES) if (pat.test(messageText)) c.forEach((x) => cats.add(x));
    if (cats.size === 0) return 0;
    let overlap = 0;
    for (const c of tool.categories) if (cats.has(c.toLowerCase())) overlap++;
    return overlap / tool.categories.length;
  }
  scoreIntent(words, tool) {
    const toolText = tool.name + " " + (tool.description ?? "");
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

// src/schema-compressor.ts
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

// src/result-cache.ts
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

// src/index.ts
var registeredTools = /* @__PURE__ */ new Set();
function mcpBridge(api) {
  const config = api.config ?? {};
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
        const mapping = compressor.decompress(compressed.name, params);
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
    description: "Find tools from connected MCP services (Notion, GitHub, Stripe, etc). Use when you need a capability not in your current tools.",
    parameters: {
      type: "object",
      properties: {
        need: { type: "string", description: 'What you need to do, e.g. "create a notion page"' }
      },
      required: ["need"]
    },
    execute: async (params) => {
      try {
        const allTools = await mcpLayer.discoverTools();
        if (allTools.length === 0) {
          return { found: 0, tools: [], message: "No MCP servers configured or no tools available." };
        }
        const ranked = analyzer.rank([{ role: "user", content: params.need }], allTools, config.analyzer);
        const registered = [];
        for (const match of ranked) {
          const compressed = compressor.compress(match.tool);
          registerCompressedTool(compressed);
          registered.push(`${match.tool.serverName}/${match.tool.name} (${Math.round(match.score * 100)}%)`);
        }
        return {
          found: ranked.length,
          tools: registered,
          message: ranked.length > 0 ? `Found ${ranked.length} relevant tool(s). They are now available for use.` : `No tools matched "${params.need}". Try rephrasing your request.`
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Tool discovery failed: ${msg}` };
      }
    }
  });
  api.onBeforeAgentTurn?.(async (context) => {
    try {
      const allTools = await mcpLayer.discoverTools();
      if (allTools.length === 0) return;
      const threshold = config.analyzer?.highConfidenceThreshold ?? 0.7;
      const ranked = analyzer.rank(context.messages, allTools, {
        ...config.analyzer,
        relevanceThreshold: threshold,
        maxToolsPerTurn: 3
      });
      for (const match of ranked) registerCompressedTool(compressor.compress(match.tool));
    } catch {
    }
  });
  api.onShutdown(async () => {
    await mcpLayer.shutdown();
  });
}
export {
  mcpBridge as default
};
