try {
  const imported = await import('playwright');
  const browser = await imported.chromium.launch({ headless: true });
  await browser.close();
  console.log(JSON.stringify({ ok: true, results: [{ name: 'Playwright Chromium', available: true }] }, null, 2));
} catch (error) {
  const diagnostic = error instanceof Error ? error.message : 'Chromium unavailable';
  console.log(JSON.stringify({
    ok: false,
    results: [{ name: 'Playwright Chromium', available: false, diagnostic }]
  }, null, 2));
  process.exitCode = 1;
}
