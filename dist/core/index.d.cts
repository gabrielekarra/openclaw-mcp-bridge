/** Configuration for a single MCP server */
interface ServerEntry {
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
interface BridgeConfig {
    mode?: 'smart' | 'traditional';
    servers?: ServerEntry[];
    autoDiscover?: boolean;
    analyzer?: AnalyzerConfig;
    cache?: CacheConfig;
}
/** MCP tool definition enriched with server metadata */
interface ToolWithServer {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    serverName: string;
    categories: string[];
}
/** Cached tool set for a server with TTL-based staleness */
declare class CachedToolSet {
    readonly tools: ToolWithServer[];
    private readonly timestamp;
    private static readonly TTL_MS;
    constructor(tools: ToolWithServer[]);
    isStale(): boolean;
}
/** Context analyzer config */
interface AnalyzerConfig {
    maxToolsPerTurn?: number;
    relevanceThreshold?: number;
    highConfidenceThreshold?: number;
    recentToolBoost?: number;
}
/** Tool relevance score from context analysis */
interface RelevanceScore {
    tool: ToolWithServer;
    score: number;
    matchType: 'keyword' | 'category' | 'history' | 'intent';
}
/** Compressed tool for minimal token usage */
interface CompressedTool {
    name: string;
    shortDescription: string;
    parameters: Record<string, unknown>;
    optionalHint: string | null;
    _originalTool: ToolWithServer;
}
/** Result cache config */
interface CacheConfig {
    enabled?: boolean;
    ttlMs?: number;
    maxEntries?: number;
}
/** Single cache entry */
interface CacheEntry {
    key: string;
    result: unknown;
    timestamp: number;
    ttlMs: number;
}

declare class McpLayer {
    private config;
    private client;
    private toolCache;
    private serverEntries;
    private lastSuccessfulServers;
    private lastFailedServers;
    constructor(config: BridgeConfig);
    /** Convert our config to mcp-use's expected format and lazily create client */
    private getClient;
    /** Get the categories configured for a server */
    private getServerCategories;
    /** Ensure a session exists for the given server, creating one if needed */
    private ensureSession;
    /** Discover all tools from all configured MCP servers */
    discoverTools(): Promise<ToolWithServer[]>;
    /** Execute a tool call on a specific server */
    callTool(serverName: string, toolName: string, params: Record<string, unknown>): Promise<unknown>;
    /** Shut down all MCP connections */
    shutdown(): Promise<void>;
    /** Get configured server names (for diagnostics) */
    getServerNames(): string[];
    /** Get status for the most recent discovery pass */
    getLastDiscoveryStatus(): {
        successfulServers: string[];
        failedServers: string[];
    };
    /** Get info about all configured servers and their connection/tool state */
    getServerInfo(): Array<{
        name: string;
        transport: string;
        connected: boolean;
        toolCount: number;
    }>;
}

declare class ContextAnalyzer {
    private recentlyUsed;
    rank(messages: {
        role?: string;
        content?: unknown;
    }[] | undefined, allTools: ToolWithServer[] | undefined, config?: AnalyzerConfig): RelevanceScore[];
    private scoreKeyword;
    private scoreCategory;
    private scoreIntent;
    private scoreHistory;
    recordUsage(toolName: string, serverName: string): void;
}

declare class SchemaCompressor {
    private originals;
    /** Compress a tool spec for minimal token usage */
    compress(tool: ToolWithServer): CompressedTool;
    /** Look up original tool by compressed name */
    getOriginal(compressedName: string): ToolWithServer | undefined;
    /** Decompress: map compressed name back to server/tool for execution */
    decompress(compressedName: string, params: Record<string, unknown>): {
        serverName: string;
        toolName: string;
        fullParams: Record<string, unknown>;
    } | undefined;
}

declare class ResultCache {
    private cache;
    private defaultTtl;
    private maxEntries;
    private enabled;
    constructor(config?: CacheConfig);
    /** Check if a tool's results are safe to cache */
    isCacheable(toolName: string): boolean;
    /** Get cached result, or null if miss/expired */
    get(server: string, tool: string, params: unknown): unknown | null;
    /** Store a result in cache */
    set(server: string, tool: string, params: unknown, result: unknown, ttlMs?: number): void;
    /** Remove all expired entries */
    prune(): void;
    /** Current cache size (for testing) */
    get size(): number;
    private makeKey;
    private evictOldest;
}

/**
 * MCP Server Auto-Discovery
 *
 * Discovery strategy (current implementation):
 * - Reads ~/.mcp.json — the standard MCP config file used by Claude Desktop
 * - Parses the `mcpServers` object and converts each entry to our ServerEntry format
 * - Supports stdio servers (command + args) and HTTP/SSE servers (url)
 * - Returns empty array if the file is missing, unreadable, or malformed
 *
 * Known config locations NOT yet supported (future work):
 * - ~/.cursor/mcp.json (Cursor IDE)
 * - ~/.config/claude-desktop/claude_desktop_config.json (Claude Desktop on Linux)
 * - ~/Library/Application Support/Claude/claude_desktop_config.json (Claude Desktop on macOS)
 * - .mcp.json in current working directory (project-local)
 *
 * When merging with explicit server config, explicit entries win on name collision
 * (handled by McpLayer constructor, not here).
 */

/**
 * Discover MCP servers from a ~/.mcp.json config file.
 * Returns empty array if file doesn't exist or is malformed.
 */
declare function discoverFromMcpJson(path?: string): ServerEntry[];

interface McpToolSchema {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
}
declare class Aggregator {
    private config;
    private mcpLayer;
    private analyzer;
    private compressor;
    private cache;
    private mode;
    /** Maps compressed name → { serverName, toolName } for routing */
    private routeMap;
    constructor(config: BridgeConfig);
    /** Discover tools from all downstream MCP servers and build route map */
    refreshTools(): Promise<void>;
    /** Return tools in MCP Tool shape for the active mode */
    getToolList(): McpToolSchema[];
    /** Call a tool by name (handles find_tools meta-tool and downstream routing) */
    callTool(name: string, params: Record<string, unknown>): Promise<{
        content: {
            type: string;
            text: string;
        }[];
        isError?: boolean;
    }>;
    /** Shut down all downstream MCP connections */
    shutdown(): Promise<void>;
    private handleFindTools;
}

export { Aggregator, type AnalyzerConfig, type BridgeConfig, type CacheConfig, type CacheEntry, CachedToolSet, type CompressedTool, ContextAnalyzer, McpLayer, type RelevanceScore, ResultCache, SchemaCompressor, type ServerEntry, type ToolWithServer, discoverFromMcpJson };
