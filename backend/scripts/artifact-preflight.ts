const results: Array<{ name: string; available: boolean; diagnostic?: string }> = [];

try {
  const imported = await import('playwright');
  const browser = await imported.chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1_600, height: 900 },
    javaScriptEnabled: false
  });
  const page = await context.newPage();
  await page.setContent('<main style="width:1600px;height:900px;background:#fff">HTML slide preflight</main>');
  await page.screenshot({ type: 'png' });
  await browser.close();
  results.push({ name: 'Playwright Chromium HTML slide renderer', available: true });
} catch (error) {
  results.push({
    name: 'Playwright Chromium HTML slide renderer',
    available: false,
    diagnostic: error instanceof Error ? error.message : 'Chromium unavailable'
  });
}

try {
  const imported = await import('pptxgenjs');
  const PptxGenJS = imported.default ?? imported;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.addSlide();
  await pptx.write({ outputType: 'nodebuffer' });
  results.push({ name: 'PptxGenJS packager', available: true });
} catch (error) {
  results.push({
    name: 'PptxGenJS packager',
    available: false,
    diagnostic: error instanceof Error ? error.message : 'PptxGenJS unavailable'
  });
}

const ok = results.every((result) => result.available);
console.log(JSON.stringify({ ok, results }, null, 2));
if (!ok) process.exitCode = 1;
