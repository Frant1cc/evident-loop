try {
  const response = await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(3_000) });
  const payload = await response.json();
  if (!response.ok || payload.code !== 1 || payload.data?.ok !== true) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
