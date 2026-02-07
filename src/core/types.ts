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
  mode?: 'smart' | 'traditional';
  servers?: ServerEntry[];
  autoDiscover?: boolean;
  analyzer?: AnalyzerConfig;
  cache?: CacheConfig;
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

/** Context analyzer config */
export interface AnalyzerConfig {
  maxToolsPerTurn?: number;          // default: 5
  relevanceThreshold?: number;       // default: 0.3
  highConfidenceThreshold?: number;  // default: 0.7
  recentToolBoost?: number;          // default: 0.15
}

/** Tool relevance score from context analysis */
export interface RelevanceScore {
  tool: ToolWithServer;
  score: number;          // 0-1
  matchType: 'keyword' | 'category' | 'history' | 'intent';
}

/** Compressed tool for minimal token usage */
export interface CompressedTool {
  name: string;
  shortDescription: string;
  parameters: Record<string, unknown>;
  optionalHint: string | null;
  _originalTool: ToolWithServer;
}

/** Result cache config */
export interface CacheConfig {
  enabled?: boolean;     // default: true
  ttlMs?: number;        // default: 30000
  maxEntries?: number;   // default: 100
}

/** Single cache entry */
export interface CacheEntry {
  key: string;
  result: unknown;
  timestamp: number;
  ttlMs: number;
}
