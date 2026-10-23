'use strict';

process.env.RUNNER_ALLOWED_TARGET_HOSTS = 'host.docker.internal,sfmbe.duckdns.org,sfm-prometheus,localhost,127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { validateStartRequest, validateCsrfRequest, monitoringQueries, server } = require('./server');
const { createEnvironmentConfig, createSshArguments } = require('./environments');
const { EnvironmentManager } = require('./environment-manager');

test('maps Local and Production to their configured targets and Prometheus addresses', () => {
  const config = createEnvironmentConfig({});
  assert.equal(config.local.backendTarget, 'http://host.docker.internal:8080');
  assert.equal(config.local.prometheusUrl, 'http://sfm-prometheus:9090');
  assert.equal(config.production.backendTarget, 'https://sfmbe.duckdns.org');
  assert.equal(config.production.prometheusUrl, 'http://127.0.0.1:19090');
  assert.equal(config.ssh.localBindAddress, '127.0.0.1');
});

test('validates allowed start requests against the selected environment and Runner limits', () => {
  const valid = validateStartRequest({
    environment: 'local', scenario: 'smoke', target: 'ping', mode: 'concurrent_users', vus: 2, durationSeconds: 30,
  }, 'local');
  assert.equal(valid.value.baseUrl, 'http://host.docker.internal:8080');
  assert.equal(valid.value.vus, 2);
  assert.equal(validateStartRequest({ environment: 'local', scenario: 'unknown', target: 'ping' }, 'local').error.code, 'UNKNOWN_SCENARIO');
  assert.equal(validateStartRequest({ environment: 'production', scenario: 'smoke', target: 'ping' }, 'local').error.code, 'ENVIRONMENT_CHANGED');
});

test('requires server-recognized Production confirmation and rejects arbitrary target overrides', () => {
  const body = { environment: 'production', confirmProduction: true, scenario: 'smoke', target: 'ping', mode: 'concurrent_users', vus: 1, durationSeconds: 30 };
  assert.equal(validateStartRequest({ ...body, confirmProduction: false }, 'production').error.code, 'PRODUCTION_CONFIRMATION_REQUIRED');
  assert.equal(validateStartRequest({ ...body, baseUrl: 'https://example.com' }, 'production').error.code, 'TARGET_URL_NOT_ALLOWED_FOR_ENVIRONMENT');
  assert.equal(validateStartRequest({ ...body, command: 'sh -c anything' }, 'production').error.code, 'UNKNOWN_PARAMETER');
  assert.equal(validateStartRequest(body, 'production').value.baseUrl, 'https://sfmbe.duckdns.org');
});

test('CSRF gate requires matching same-origin token and rejects cross-origin POSTs', () => {
  const request = { headers: { origin: 'http://127.0.0.1:4173', host: '127.0.0.1:4173', 'x-sfm-lab-csrf': 'known-test-token' } };
  assert.equal(validateCsrfRequest(request, 'known-test-token'), true);
  assert.equal(validateCsrfRequest({ ...request, headers: { ...request.headers, origin: 'https://attacker.example' } }, 'known-test-token'), false);
  assert.equal(validateCsrfRequest({ ...request, headers: { ...request.headers, 'x-sfm-lab-csrf': 'wrong-token' } }, 'known-test-token'), false);
});

test('HTTP start route parses JSON, enforces CSRF, and returns structured validation errors', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const config = await (await fetch(`${origin}/api/config`)).json();
    const response = await fetch(`${origin}/api/start`, {
      method: 'POST',
      headers: { origin, 'x-sfm-lab-csrf': config.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ environment: 'local', scenario: 'unknown', target: 'ping' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'UNKNOWN_SCENARIO');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('SSH arguments use verified host keys and loopback-only forwarding without a shell', () => {
  const config = createEnvironmentConfig({
    PRODUCTION_SSH_HOST: 'ec2.example.net', PRODUCTION_SSH_USER: 'sfm',
    PRODUCTION_PROMETHEUS_REMOTE_HOST: '127.0.0.1', PRODUCTION_PROMETHEUS_REMOTE_PORT: '9090',
  });
  const args = createSshArguments(config, '/tmp/ssh-key');
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('-N'));
  assert.ok(args.includes('127.0.0.1:19090:127.0.0.1:9090'));
  const missingHost = createEnvironmentConfig({ PRODUCTION_SSH_USER: 'sfm', PRODUCTION_PROMETHEUS_REMOTE_HOST: '127.0.0.1', PRODUCTION_PROMETHEUS_REMOTE_PORT: '9090' });
  assert.throws(() => createSshArguments(missingHost, '/tmp/key'), { message: /verified EC2/ });
});

test('Prometheus query templates use the configured service job', () => {
  const queries = monitoringQueries('sfm-prod');
  assert.match(queries.requestsPerSecond, /job="sfm-prod"/);
  assert.match(queries.p95LatencyMilliseconds, /histogram_quantile\(0\.95/);
  assert.match(queries.http5xxErrorRatePercent, /http_response_status_code=~"5\.\."/);
});

test('failed Production setup rolls back and leaves Local selected', async () => {
  const config = createEnvironmentConfig({
    PRODUCTION_SSH_HOST: 'ec2.example.net', PRODUCTION_SSH_USER: 'sfm',
    PRODUCTION_PROMETHEUS_REMOTE_HOST: '127.0.0.1', PRODUCTION_PROMETHEUS_REMOTE_PORT: '9090',
  });
  const manager = new EnvironmentManager(config, {
    fetch: async () => ({ ok: true, json: async () => ({ status: 'success', data: { result: [{ value: [0, '1'] }] } }) }),
    fs: { readFile: async () => { throw new Error('missing test secret'); }, rm: async () => {} },
  });
  await assert.rejects(manager.switchTo('production'), { code: 'SSH_CREDENTIALS_UNAVAILABLE' });
  assert.equal(manager.currentEnvironment, 'local');
  assert.equal(manager.tunnelState, 'disabled');
});

test('concurrent tunnel requests create only one SSH child and cleanup it', async () => {
  const config = createEnvironmentConfig({
    PRODUCTION_SSH_HOST: 'ec2.example.net', PRODUCTION_SSH_USER: 'sfm',
    PRODUCTION_PROMETHEUS_REMOTE_HOST: '127.0.0.1', PRODUCTION_PROMETHEUS_REMOTE_PORT: '9090',
  });
  const child = new EventEmitter();
  child.kill = () => setImmediate(() => child.emit('close', 0, null));
  let spawnCount = 0;
  let removedKey = false;
  const manager = new EnvironmentManager(config, {
    spawn: () => { spawnCount += 1; setImmediate(() => child.emit('spawn')); return child; },
    fs: {
      readFile: async (file) => file.endsWith('known_hosts') ? 'verified-host-key' : Buffer.from('private-key'),
      writeFile: async () => {},
      rm: async () => { removedKey = true; },
    },
  });
  await Promise.all([manager.startTunnel(), manager.startTunnel()]);
  assert.equal(spawnCount, 1);
  await manager.dispose();
  assert.equal(removedKey, true);
  assert.equal(manager.tunnelChild, null);
});
