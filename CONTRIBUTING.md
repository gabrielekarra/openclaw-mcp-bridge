# Contributing

## Setup

```bash
git clone https://github.com/gabrielekarra/openclaw-mcp-bridge.git
cd openclaw-mcp-bridge
pnpm install
pnpm build
pnpm test
```

## Development

```bash
pnpm test:watch     # run tests on file change
pnpm lint           # type check (tsc --noEmit)
pnpm build          # build ESM + CJS + DTS to dist/
```

## Testing with a real OpenClaw instance

```bash
pnpm build
openclaw plugins install .
openclaw gateway restart
```

Then ask the agent: "Use mcp_find_tools to find tools for creating a Notion page."

## Code Style

- TypeScript, ESM imports (`import ... from './foo.js'`)
- Keep individual modules under 150 LOC
- All async operations need error handling with graceful fallbacks
- No new dependencies without discussion — the project is intentionally lightweight

## Pull Requests

- Include tests for new functionality
- Run `pnpm lint && pnpm test` before submitting
- Keep PRs focused — one feature or fix per PR
