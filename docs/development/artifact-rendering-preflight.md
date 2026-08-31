# Artifact rendering preflight

PPTX and PDF artifacts are generated on demand in the backend process. Rendering
does not start a resident worker or daemon. Before enabling production PDF
delivery, run:

The product surface is an on-demand logical Artifact Agent with an explicit
internal pipeline (`frozen snapshot -> typed plan -> consented image choice ->
renderer`); it is not a ToolRuntime registration or a hidden general-purpose
tool loop.

```bash
pnpm --filter backend artifacts:preflight
```

The check requires Playwright's Chromium browser for semantic HTML → PDF. PPTX
is written by PptxGenJS and does not need LibreOffice. Visual raster QA with
LibreOffice/Poppler is not part of the generation pipeline.

Slide/page targets are soft planning goals: the Artifact Agent must produce
substantive content, then persist the actual planned count (PPTX 8-15; PDF
6-20) as the target. Renderers never add blank or placeholder pages. In-process
checks still cover file headers, citations, and the renderer layout manifest.
