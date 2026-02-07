import { MCPClient } from 'mcp-use';
import type { Tool } from 'mcp-use';
import { discoverFromMcpJson } from './discovery.js';
import { CachedToolSet } from './types.js';
import type { BridgeConfig, ServerEntry, ToolWithServer } from './types.js';

export class McpLayer {
  private client: MCPClient | null = null;
  private toolCache = new Map<string, CachedToolSet>();
  private serverEntries: ServerEntry[];

  constructor(private config: BridgeConfig) {
    const explicit = config.servers ?? [];
    const discovered = config.autoDiscover !== false ? discoverFromMcpJson() : [];

    // Merge: explicit servers take priority (by name)
    const byName = new Map<string, ServerEntry>();
    for (const s of discovered) byName.set(s.name, s);
    for (const s of explicit) byName.set(s.name, s);
    this.serverEntries = [...byName.values()];
  }

  /** Convert our config to mcp-use's expected format and lazily create client */
  private getClient(): MCPClient {
    if (this.client) return this.client;

    const mcpServers: Record<string, Record<string, unknown>> = {};
    for (const server of this.serverEntries) {
      if (server.transport === 'stdio' && server.command) {
        mcpServers[server.name] = {
          command: server.command,
          args: server.args ?? [],
          env: server.env,
        };
      } else if (server.url) {
        mcpServers[server.name] = {
          url: server.url,
          headers: server.headers,
        };
      }
    }

    this.client = MCPClient.fromDict({ mcpServers });
    return this.client;
  }

  /** Get the categories configured for a server */
  private getServerCategories(serverName: string): string[] {
    return this.serverEntries.find(s => s.name === serverName)?.categories ?? [];
  }

  /** Ensure a session exists for the given server, creating one if needed */
  private async ensureSession(client: MCPClient, serverName: string) {
    const existing = client.getSession(serverName);
    if (existing) return existing;
    return client.createSession(serverName);
  }

  /** Discover all tools from all configured MCP servers */
  async discoverTools(): Promise<ToolWithServer[]> {
    if (this.serverEntries.length === 0) return [];

    const client = this.getClient();
    const allTools: ToolWithServer[] = [];

    for (const serverName of client.getServerNames()) {
      // Return cached tools if still fresh
      const cached = this.toolCache.get(serverName);
      if (cached && !cached.isStale()) {
        allTools.push(...cached.tools);
        continue;
      }

      try {
        const session = await this.ensureSession(client, serverName);
        const rawTools = await session.listTools();
        const tools: Tool[] = Array.isArray(rawTools) ? rawTools : [];
        const enriched: ToolWithServer[] = tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown> | undefined,
          serverName,
          categories: this.getServerCategories(serverName),
        }));

        this.toolCache.set(serverName, new CachedToolSet(enriched));
        allTools.push(...enriched);
      } catch (err) {
        console.warn(`[mcp-bridge] Failed to list tools from "${serverName}":`, err);
        // Skip failed servers, continue with others
      }
    }

    return allTools;
  }

  /** Execute a tool call on a specific server */
  async callTool(
    serverName: string,
    toolName: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const client = this.getClient();
    const session = await this.ensureSession(client, serverName);
    return session.callTool(toolName, params);
  }

  /** Shut down all MCP connections */
  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.toolCache.clear();
  }

  /** Get configured server names (for diagnostics) */
  getServerNames(): string[] {
    return this.serverEntries.map(s => s.name);
  }

  /** Get info about all configured servers and their connection/tool state */
  getServerInfo(): Array<{ name: string; transport: string; connected: boolean; toolCount: number }> {
    return this.serverEntries.map(s => ({
      name: s.name,
      transport: s.transport,
      connected: this.client !== null && this.client.getSession(s.name) !== null,
      toolCount: this.toolCache.get(s.name)?.tools.length ?? 0,
    }));
  }
}
