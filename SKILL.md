# MCP Bridge — Agent Skill Guide

You have access to external tools via MCP (Model Context Protocol) servers.

## Available meta-tools

- `mcp_find_tools` — Find tools for a specific task. Pass `{ need: "what you need" }`.
- `mcp_list_servers` — List connected MCP servers and their tool counts.

## How to use

1. When you need external capabilities, call `mcp_find_tools` with a description
2. Review the returned tools and their descriptions
3. Call the tool you need directly by its name with the required parameters
4. The MCP bridge routes your call to the correct server automatically

## Examples

"I need to create a GitHub issue" → call `mcp_find_tools({ need: "create github issue" })`
"What servers are available?" → call `mcp_list_servers({})`
"List all tools" → call `mcp_find_tools({ need: "" })`

## Tips
- Be specific with `need` for better results (e.g. "create github issue" not "github")
- If no tools match, try broader terms
- Tools from all connected servers are searched simultaneously
