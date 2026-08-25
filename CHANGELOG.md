# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Research event timeline now shows context micro-compression and summary-compression lifecycle events, including trigger threshold and before/after Token estimates

- **MCP Managed Presets**: One-click enablement for built-in MCP presets (Context7 and Memory)
  - Backend-managed presets with cross-platform command resolution (Windows/macOS/Linux)
  - Fixed package versions: Context7 4.0.3, Memory 2026.7.4
  - Version-aware npx arguments support both npm 6 and npm 7+ without prompts
  - Existing managed connections automatically migrate stale package commands before retesting
  - Idempotent operations: repeated enable returns existing server without duplicates
  - Auto-recovery: application restart automatically restores enabled presets
  - New API endpoints: `GET /api/mcp/presets`, `POST /api/mcp/presets/:id/enable`, `POST /api/mcp/presets/:id/disable`
  - Frontend components: McpPresetCard and PresetConsentDialog with enable flow visualization
  - Local approval policy: managed presets define approval rules that override remote readOnlyHint claims
  - MCP output size limit: 1MB truncation to prevent memory issues
  - Documentation: Architecture guide (`docs/mcp-managed-presets.md`) and version tracking (`docs/mcp-package-versions.md`)

- **Cross-Conversation Artifact Library**: View all research documents and Agent reports in a unified library
  - New "产物" tab in navigation
  - Global API endpoints for all artifacts and Agent reports
  - Removed `fetch_source_image` tool (no longer needed in library context)

### Changed

- MCP Management UI: Reorganized to show built-in presets separately from custom connections
- Deprecated frontend preset definitions in `frontend/src/mcp/presets.ts` (now backend-managed)
- Connected MCP tools are automatically authorized for new research turns and hidden from the per-turn tool picker; MCP availability is controlled only from MCP Management
- `read_evidence`（回查证据）由后端为每个研究任务自动授权，并从逐轮工具选择菜单中隐藏

### Security

- Command whitelist validation for MCP presets (only `npx` and `npx.cmd` allowed)
- Argument safety checks: reject shell meta-characters (`;`, `&`, `|`, `` ` ``, `$`, `()`, `{}`)
- No shell mode: use direct process spawning instead of `shell: true`
- Local approval policy overrides remote claims to prevent bypass attacks

### Fixed

- MCP preset commands now work cross-platform (previously Windows-only with `cmd /c`)
- DeepSeek DSML/tool-call protocol text is filtered before chat streaming, persistence, and research-step events

## [Previous Versions]

See git history for changes prior to this changelog.
