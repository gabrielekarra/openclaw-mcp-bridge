# Changelog

## 0.1.0 (2026-02-06)

### Added
- Initial release
- MCP server connectivity via mcp-use MCPClient
- Auto-discovery of servers from `~/.mcp.json`
- `mcp_find_tools` meta-tool for on-demand tool discovery
- Context-aware relevance scoring (keyword, category, intent, history)
- Schema compression (~83% token reduction per tool)
- Result caching for read-only tools with configurable TTL
- Auto-injection of high-confidence tools via `onBeforeAgentTurn` hook
- Support for stdio, HTTP, and SSE transports
- Comprehensive test suite (48+ tests)
