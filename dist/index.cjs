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
  default: () => mcpBridge
});
module.exports = __toCommonJS(index_exports);

// src/mcp-layer.ts
var import_mcp_use = require("mcp-use");

// src/discovery.ts
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

// src/index.ts
function sanitizeName(s) {
  return s.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
}
function makeToolName(serverName, toolName) {
  return `mcp_${sanitizeName(serverName)}_${sanitizeName(toolName)}`;
}
var registeredTools = /* @__PURE__ */ new Set();
function registerMcpTool(api, mcpLayer, tool) {
  const name = makeToolName(tool.serverName, tool.name);
  if (registeredTools.has(name)) return name;
  api.registerTool({
    name,
    description: tool.description ?? `MCP tool: ${tool.serverName}/${tool.name}`,
    parameters: tool.inputSchema ?? { type: "object", properties: {} },
    execute: async (params) => {
      try {
        return await mcpLayer.callTool(tool.serverName, tool.name, params);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Tool call failed: ${message}` };
      }
    }
  });
  registeredTools.add(name);
  return name;
}
function mcpBridge(api) {
  const config = api.config ?? {};
  const mcpLayer = new McpLayer(config);
  api.registerTool({
    name: "mcp_find_tools",
    description: "Find tools from connected MCP services (Notion, GitHub, Stripe, etc). Use when you need a capability not in your current tools.",
    parameters: {
      type: "object",
      properties: {
        need: {
          type: "string",
          description: 'What you need to do, e.g. "create a notion page" or "list github issues"'
        }
      },
      required: ["need"]
    },
    execute: async (params) => {
      try {
        const allTools = await mcpLayer.discoverTools();
        if (allTools.length === 0) {
          return {
            found: 0,
            tools: [],
            message: "No MCP servers configured or no tools available. Configure servers in the plugin settings or ensure ~/.mcp.json exists."
          };
        }
        const registered = [];
        for (const tool of allTools) {
          const name = registerMcpTool(api, mcpLayer, tool);
          registered.push(`${tool.serverName}/${tool.name}`);
        }
        return {
          found: allTools.length,
          tools: registered,
          message: `Found ${allTools.length} tool(s). They are now available for use.`
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Tool discovery failed: ${message}` };
      }
    }
  });
  api.onShutdown(async () => {
    await mcpLayer.shutdown();
  });
}
