'use strict';

const path = require('node:path');

function positiveInteger(value, fallback, name, min = 1, max = 65535) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function parseOrigin(value, name, protocols) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute HTTP or HTTPS origin.`); }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP or HTTPS origin without credentials, path, query, or fragment.`);
  }
  return url.origin;
}

function createEnvironmentConfig(env = process.env) {
  const localBackend = parseOrigin(env.LOCAL_BACKEND_URL || 'http://host.docker.internal:8080', 'LOCAL_BACKEND_URL', ['http:']);
  const localPrometheus = parseOrigin(env.LOCAL_PROMETHEUS_URL || 'http://sfm-prometheus:9090', 'LOCAL_PROMETHEUS_URL', ['http:']);
  const productionBackend = parseOrigin(env.PRODUCTION_BACKEND_URL || 'https://sfmbe.duckdns.org', 'PRODUCTION_BACKEND_URL', ['https:']);
  const productionPrometheus = parseOrigin(env.PRODUCTION_PROMETHEUS_URL || 'http://127.0.0.1:19090', 'PRODUCTION_PROMETHEUS_URL', ['http:']);
  const productionPrometheusUrl = new URL(productionPrometheus);
  if (!['127.0.0.1', '::1', 'localhost'].includes(productionPrometheusUrl.hostname)) {
    throw new Error('PRODUCTION_PROMETHEUS_URL must use a loopback address so Prometheus is never exposed publicly.');
  }

  const sshLocalPort = positiveInteger(env.PRODUCTION_SSH_LOCAL_PORT, 19090, 'PRODUCTION_SSH_LOCAL_PORT');
  if (Number(productionPrometheusUrl.port || 80) !== sshLocalPort) {
    throw new Error('PRODUCTION_PROMETHEUS_URL port must match PRODUCTION_SSH_LOCAL_PORT.');
  }

  return Object.freeze({
    local: Object.freeze({ name: 'local', backendTarget: localBackend, prometheusUrl: localPrometheus }),
    production: Object.freeze({ name: 'production', backendTarget: productionBackend, prometheusUrl: productionPrometheus }),
    initialEnvironment: env.DASHBOARD_INITIAL_ENVIRONMENT || 'local',
    productionLimits: Object.freeze({
      vus: positiveInteger(env.PRODUCTION_MAX_VUS, 25, 'PRODUCTION_MAX_VUS', 1, 1000),
      requestsPerSecond: positiveInteger(env.PRODUCTION_MAX_REQUESTS_PER_SECOND, 25, 'PRODUCTION_MAX_REQUESTS_PER_SECOND', 1, 1000),
      durationSeconds: positiveInteger(env.PRODUCTION_MAX_DURATION_SECONDS, 120, 'PRODUCTION_MAX_DURATION_SECONDS', 10, 3600),
    }),
    ssh: Object.freeze({
      host: (env.PRODUCTION_SSH_HOST || '').trim(),
      user: (env.PRODUCTION_SSH_USER || '').trim(),
      port: positiveInteger(env.PRODUCTION_SSH_PORT, 22, 'PRODUCTION_SSH_PORT'),
      keyPath: env.PRODUCTION_SSH_KEY_PATH || '/run/ssh-secrets/production_key',
      knownHostsPath: env.PRODUCTION_SSH_KNOWN_HOSTS_PATH || '/run/ssh-secrets/known_hosts',
      localBindAddress: '127.0.0.1',
      localPort: sshLocalPort,
      remoteHost: (env.PRODUCTION_PROMETHEUS_REMOTE_HOST || '').trim(),
      remotePort: positiveInteger(env.PRODUCTION_PROMETHEUS_REMOTE_PORT, 0, 'PRODUCTION_PROMETHEUS_REMOTE_PORT', 0),
    }),
    metricsJob: env.PROMETHEUS_SFM_BE_JOB || 'sfm-be',
  });
}

function validateEnvironmentConfig(config) {
  if (!['local', 'production'].includes(config.initialEnvironment)) throw new Error('DASHBOARD_INITIAL_ENVIRONMENT must be local or production.');
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(config.metricsJob)) throw new Error('PROMETHEUS_SFM_BE_JOB contains unsupported characters.');
  return config;
}

function createSshArguments(config, identityFile) {
  const ssh = config.ssh;
  if (!/^[a-zA-Z0-9.-]+$/.test(ssh.host)) throw new Error('Configure PRODUCTION_SSH_HOST with the verified EC2 DNS name or IPv4 address.');
  if (!/^[a-zA-Z0-9_.-]+$/.test(ssh.user)) throw new Error('Configure PRODUCTION_SSH_USER with the authorized SSH account.');
  if (!ssh.remoteHost || !/^[a-zA-Z0-9_.:-]+$/.test(ssh.remoteHost) || ssh.remotePort < 1) {
    throw new Error('Configure PRODUCTION_PROMETHEUS_REMOTE_HOST and PRODUCTION_PROMETHEUS_REMOTE_PORT for the private Prometheus endpoint reachable from EC2.');
  }
  if (!path.isAbsolute(ssh.keyPath) || !path.isAbsolute(ssh.knownHostsPath)) throw new Error('SSH key and known_hosts paths must be absolute container paths.');

  return [
    '-N',
    '-L', `${ssh.localBindAddress}:${ssh.localPort}:${ssh.remoteHost}:${ssh.remotePort}`,
    '-p', String(ssh.port),
    '-i', identityFile,
    '-o', `UserKnownHostsFile=${ssh.knownHostsPath}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    `${ssh.user}@${ssh.host}`,
  ];
}

module.exports = { createEnvironmentConfig, validateEnvironmentConfig, createSshArguments, parseOrigin };
