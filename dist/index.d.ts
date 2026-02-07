export { Aggregator, AnalyzerConfig, BridgeConfig, CacheConfig, CacheEntry, CachedToolSet, CompressedTool, ContextAnalyzer, McpLayer, RelevanceScore, ResultCache, SchemaCompressor, ServerEntry, ToolWithServer, discoverFromMcpJson } from './core/index.js';

declare function mcpBridge(api: any): void;

export { mcpBridge as default };
