# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **MCP Managed Presets**: One-click enablement for built-in MCP presets (Context7 and Memory)
  - Backend-managed presets with cross-platform command resolution (Windows/macOS/Linux)
  - Fixed package versions: Context7 0.1.5, Memory 0.1.0
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

### Security

- Command whitelist validation for MCP presets (only `npx` and `npx.cmd` allowed)
- Argument safety checks: reject shell meta-characters (`;`, `&`, `|`, `` ` ``, `$`, `()`, `{}`)
- No shell mode: use direct process spawning instead of `shell: true`
- Local approval policy overrides remote claims to prevent bypass attacks

### Fixed

- MCP preset commands now work cross-platform (previously Windows-only with `cmd /c`)

## [Previous Versions]

See git history for changes prior to this changelog.
