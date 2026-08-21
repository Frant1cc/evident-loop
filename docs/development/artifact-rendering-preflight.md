# Artifact rendering preflight

PPTX and PDF artifacts are generated on demand in the backend process. Rendering
does not start a resident worker or daemon. Before enabling production artifact
delivery, run:

The product surface is an on-demand logical Artifact Agent with an explicit
internal pipeline (`frozen snapshot -> typed plan -> consented image choice ->
renderer -> per-page QA`); it is not a ToolRuntime registration or a hidden
general-purpose tool loop.

```bash
pnpm --filter backend artifacts:preflight
```

The check requires:

- Playwright's Chromium browser for semantic HTML → PDF;
- LibreOffice (`soffice`) for PPTX → PDF conversion;
- Poppler (`pdfinfo`, `pdftoppm`, `pdftotext`, and `pdffonts`) for page count,
  empty-page checks, overflow/text diagnostics, font diagnostics, and
all-page raster/contact-sheet preview generation.

Slide/page targets are soft planning goals: the Artifact Agent must produce
substantive content, then persist the actual planned count (PPTX 8-15; PDF
6-20) as the target. Renderers never add blank or placeholder pages. QA still
requires the rasterized/converted actual count to equal that persisted target.

Command locations can be supplied with `LIBREOFFICE_BIN`,
`POPPLER_PDFINFO_BIN`, `POPPLER_PDFTOPPM_BIN`, `POPPLER_PDFTOTEXT_BIN`, and
`POPPLER_PDFFONTS_BIN`. The runtime invokes these
commands with fixed argument arrays, short timeouts, and a temporary directory;
model input cannot supply a command or path. If a dependency is missing, the
artifact output is marked failed with `renderer_unavailable`; it is never
reported as completed after structural-only validation.
