import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const project = `evident-loop-smoke-${process.pid}`;
const temporary = await mkdtemp(path.join(tmpdir(), 'evident-loop-deploy-'));
const environment = {
  ...process.env,
  SITE_HOST: 'localhost',
  APP_ORIGIN: 'http://localhost:18080',
  NGINX_INTERNAL_IP: '172.30.241.10',
  DEMO_NETWORK_SUBNET: '172.30.241.0/24',
  APP_VERSION: 'local'
};
const base = ['compose', '--project-name', project, '--env-file', 'deploy/.env.example', '-f', 'compose.production.yml'];
const files = ['-f', 'deploy/tests/compose.smoke.yml'];
function docker(args, { https = false, quiet = false } = {}) {
  const result = spawnSync('docker', [...base, ...(https ? ['-f', 'compose.https.yml'] : []), ...files, ...args], {
    cwd: root, env: environment, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed:\n${result.stderr}\n${result.stdout}`);
  if (!quiet && result.stdout) process.stdout.write(result.stdout);
  return result.stdout;
}
const endpoint = 'http://localhost:18080';
async function api(route, { method = 'GET', cookie, body, headers = {} } = {}) {
  return fetch(endpoint + route, {
    method,
    headers: { Host: 'localhost', Origin: environment.APP_ORIGIN, 'Content-Type': 'application/json', 'X-Requested-With': 'EvidentLoop', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}
function secureApi(route, ca) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest('https://localhost:18443' + route, {
      ca,
      family: 4,
      headers: { Host: 'localhost', Origin: 'https://localhost' }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.once('error', reject);
    req.end();
  });
}

try {
  docker(['config', '--quiet']);
  docker(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  const health = await api('/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).data.ok, true);
  const page = await fetch(endpoint, { headers: { Host: 'localhost' } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/);
  assert.equal((await fetch(endpoint + '/a/spa/route', { headers: { Host: 'localhost' } })).status, 200);
  assert.equal((await api('/api/missing-route')).status, 403);

  const aliceSession = await api('/api/demo');
  const alice = aliceSession.headers.get('set-cookie').split(';')[0];
  const bobSession = await api('/api/demo');
  const bob = bobSession.headers.get('set-cookie').split(';')[0];
  const create = await api('/api/research/conversations', { method: 'POST', cookie: alice });
  assert.equal(create.status, 201);
  const id = (await create.json()).data.conversation.id;
  const bobList = await api('/api/research/conversations', { cookie: bob });
  assert.equal((await bobList.json()).data.conversations.length, 0);
  assert.equal((await api(`/api/research/conversations/${id}`, { cookie: bob })).status, 404);
  assert.equal((await api('/api/mcp/servers', { cookie: alice })).status, 403);

  const started = await api(`/api/research/conversations/${id}/messages`, {
    method: 'POST', cookie: alice, body: { content: 'Test deployment', toolPolicy: { mode: 'none' } }
  });
  assert.equal(started.status, 202);
  const runId = (await started.json()).data.run.id;
  const stream = await api(`/api/research/runs/${runId}/events`, { cookie: alice });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  assert.match(stream.headers.get('cache-control'), /private, no-store/);
  assert.match(await stream.text(), /Deployment smoke test completed/);
  const quota = await api('/api/demo', { cookie: alice });
  assert.equal((await quota.json()).data.remaining, 9);
  await api('/api/demo', { cookie: alice, headers: { 'X-Forwarded-For': '192.0.2.99' } });
  const fakeIpBuckets = docker(['exec', '-T', 'backend', 'node', '--input-type=module', '-e', `
    import { sqlite } from './dist/db.js';
    console.log(sqlite.prepare("SELECT COUNT(DISTINCT subject) AS count FROM demo_usage WHERE bucket = 'request_ip'").get().count);
  `], { quiet: true }).trim();
  assert.equal(fakeIpBuckets, '1', 'Nginx must overwrite forged client forwarding headers');

  const documentRun = await api(`/api/research/conversations/${id}/messages`, {
    method: 'POST',
    cookie: alice,
    body: { content: '根据当前结论生成 PPT、Word 和 PDF 报告。', toolPolicy: { mode: 'selected', names: ['start_document_generation'] } }
  });
  assert.equal(documentRun.status, 202);
  const documentRunId = (await documentRun.json()).data.run.id;
  const documentEvents = await api(`/api/research/runs/${documentRunId}/events`, { cookie: alice });
  assert.equal(documentEvents.status, 200);
  await documentEvents.text();
  const generations = `/api/research/conversations/${id}/artifacts`;
  const list = await api(generations, { cookie: alice });
  assert.equal(list.status, 200);
  const [draft] = (await list.json()).data.generations;
  assert.equal(draft?.status, 'awaiting_confirmation');
  const draftPath = `/api/artifacts/generations/${draft.id}`;
  assert.equal((await api(generations, { cookie: bob })).status, 404);
  const savedDraft = await api(draftPath, { method: 'PATCH', cookie: alice, body: { spec: { ...draft.spec, title: '部署验收报告' } } });
  assert.equal(savedDraft.status, 200);
  const render = await api(draftPath + '/render', { method: 'POST', cookie: alice });
  assert.equal(render.status, 202);
  let { generation } = (await render.json()).data;
  for (let attempt = 0; attempt < 130 && ['rendering', 'validating', 'repairing'].includes(generation.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const snapshot = await api(`/api/artifacts/generations/${generation.id}`, { cookie: alice });
    assert.equal(snapshot.status, 200);
    generation = (await snapshot.json()).data.generation;
  }
  assert.equal(generation.status, 'completed', JSON.stringify(generation.outputs.map(({ format, status, diagnostics }) => ({ format, status, diagnostics }))));
  assert.deepEqual(generation.outputs.map((output) => output.format).sort(), ['docx', 'pdf', 'pptx']);
  for (const output of generation.outputs) {
    const file = `/api/artifact-files/${output.id}`;
    const download = await api(file + '/download', { cookie: alice });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /^attachment/);
    const data = Buffer.from(await download.arrayBuffer());
    assert.equal(data.subarray(0, output.format === 'pdf' ? 4 : 2).toString(), output.format === 'pdf' ? '%PDF' : 'PK');
    const preview = await api(file + '/preview', { cookie: alice });
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('content-disposition'), /^inline/);
    await preview.arrayBuffer();
    assert.equal((await api(file + '/download', { cookie: bob })).status, 404);
  }

  assert.match(docker(['exec', '-T', 'backend', 'node', 'seed-demo.mjs'], { quiet: true }), /created: 1/);
  assert.match(docker(['exec', '-T', 'backend', 'node', 'seed-demo.mjs'], { quiet: true }), /created: 0/);
  assert.match(docker(['exec', '-T', 'backend', 'node', 'seed-demo.mjs', '--index'], { quiet: true }), /Indexed 1 public documents/);
  docker(['up', '-d', '--force-recreate', '--wait', '--no-deps', 'backend']);
  const saved = await api(`/api/research/conversations/${id}`, { cookie: alice });
  assert.equal(saved.status, 200);
  assert.equal((await (await api('/api/demo', { cookie: alice })).json()).data.remaining, 7);
  const published = JSON.parse(docker(['ps', '--format', 'json', 'backend'], { quiet: true }));
  assert.equal(published.Publishers?.length ?? 0, 0);

  // Test the domain TLS overlay with a locally trusted throwaway certificate, without contacting an ACME server.
  const opensslConfig = path.join(temporary, 'openssl.cnf');
  await writeFile(opensslConfig, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  const certificate = path.join(temporary, 'fullchain.pem');
  const key = path.join(temporary, 'privkey.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', opensslConfig, '-keyout', key, '-out', certificate], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  docker(['run', '--rm', '--no-deps', '--entrypoint', 'sh', '-v', `${temporary}:/source:ro`, 'certbot', '-c',
    'mkdir -p /etc/letsencrypt/live/evident-loop && cp /source/fullchain.pem /source/privkey.pem /etc/letsencrypt/live/evident-loop/']);
  docker(['up', '-d', '--wait', '--wait-timeout', '180'], { https: true });
  const redirect = await fetch(endpoint + '/api/demo', { headers: { Host: 'localhost' }, redirect: 'manual' });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), 'https://localhost/api/demo');
  const secure = await secureApi('/api/demo', await readFile(certificate));
  assert.equal(secure.status, 200);
  assert.match(secure.headers['set-cookie'][0], /__Host-evident_demo=/);
  assert.match(secure.headers['set-cookie'][0], /Secure/);
  docker(['exec', '-T', 'nginx', 'nginx', '-t'], { https: true });
  docker(['exec', '-T', 'nginx', 'nginx', '-s', 'reload'], { https: true });
  console.log('Deployment smoke passed: HTTP, SPA, guest isolation, quotas, SSE, document rendering, proxy IPs, sample indexing, persistent volumes, HTTPS and Secure cookies.');
} catch (error) {
  try { docker(['logs', '--tail', '35', 'nginx', 'backend']); } catch { /* Keep the original failure. */ }
  throw error;
} finally {
  // The project name is generated above; production/default volumes are never removed.
  try { docker(['down', '--volumes', '--remove-orphans'], { https: true }); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}
