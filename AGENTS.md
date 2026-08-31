# Repository Guidelines

## Project Structure & Module Organization

EvidentLoop is a pnpm workspace:

- `backend/src/` contains the Express/TypeScript service. Keep HTTP adapters in `routes/`, application entry points in `modules/`, and domain code in `runtime/`, `research/`, `knowledge/`, `rag/`, `agent/`, `tools/`, and `documents/`.
- `frontend/src/` contains the Vue 3/Vite client, organized into `components/`, `api/`, `composables/`, and `markdown/`.
- `packages/stream-protocol/src/` holds shared streaming contracts.
- `docs/development/` contains architecture and implementation notes; `docs/knowledge/` and `knowledge-samples/` contain sample/evaluation content.

Preserve the backend dependency direction: routes call module application APIs, providers implement neutral contracts, and cross-module access goes through public `index.ts` exports. `app.ts` is the production composition root.

## Build, Test, and Development Commands

Requires Node.js 20+, pnpm 10+, Docker, and configured `backend/.env` credentials.

```bash
pnpm install --frozen-lockfile  # Install workspace dependencies
pnpm qdrant:up                  # Start local Qdrant
pnpm dev                        # Run frontend and backend together
pnpm typecheck                  # Check all workspace TypeScript
pnpm test                       # Run backend and frontend node:test suites
pnpm build                      # Build both applications
pnpm --filter backend runtime:verify  # Verify runtime invariants
pnpm rag:eval:smoke             # Run the dependency-light RAG smoke evaluation
```

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, semicolons, and single-quoted imports/strings, matching nearby code. Use `camelCase` for variables/functions, `PascalCase` for Vue components and types, and descriptive lower-case module directories. Keep imports using `.js` extensions in backend TypeScript and use the frontend `@/` alias where appropriate. There is no substantive formatter or linter configured; rely on `typecheck`, tests, and local style consistency.

## Testing Guidelines

Tests use Node’s built-in `node:test` runner through `tsx`. Place tests beside implementation as `*.test.ts` and cover behavior, boundary rules, and failure/recovery paths. No coverage threshold is enforced. Run the focused package test while iterating, then run `pnpm typecheck`, `pnpm test`, and `pnpm build` before submitting.

## Commit & Pull Request Guidelines

Use concise Conventional Commit-style subjects with an optional scope, for example `feat(rag): add hybrid scoring` or `docs: clarify setup`. Keep commits and pull requests focused. PRs should describe the problem, design tradeoffs, verification commands, known limitations, and compatibility or migration impact. Include screenshots or recordings for frontend changes and update documentation when configuration, APIs, or workflows change.

## Security & Configuration

Copy `backend/.env.example` to `backend/.env`; never commit secrets, `.env` files, databases, generated artifacts, or local configuration. The development API has no authentication or rate limiting, so keep it off the public internet and redact credentials, document content, and personal data from logs or screenshots.
