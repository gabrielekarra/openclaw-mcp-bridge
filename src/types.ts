/** Configuration for a single MCP server */
export interface ServerEntry {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  categories?: string[];
}

/** Full plugin configuration */
export interface BridgeConfig {
  servers?: ServerEntry[];
  autoDiscover?: boolean;
  analyzer?: {
    maxToolsPerTurn?: number;
    relevanceThreshold?: number;
    highConfidenceThreshold?: number;
  };
  cache?: {
    enabled?: boolean;
    ttlMs?: number;
  };
}

/** MCP tool definition enriched with server metadata */
export interface ToolWithServer {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  serverName: string;
  categories: string[];
}

/** Cached tool set for a server with TTL-based staleness */
export class CachedToolSet {
  readonly tools: ToolWithServer[];
  private readonly timestamp: number;
  private static readonly TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(tools: ToolWithServer[]) {
    this.tools = tools;
    this.timestamp = Date.now();
  }

  isStale(): boolean {
    return Date.now() - this.timestamp > CachedToolSet.TTL_MS;
  }
}
