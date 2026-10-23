'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createSshArguments } = require('./environments');

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

class EnvironmentManager {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.fetch = dependencies.fetch || globalThis.fetch;
    this.spawn = dependencies.spawn || spawn;
    this.fs = dependencies.fs || fs;
    this.currentEnvironment = config.initialEnvironment;
    this.switching = false;
    this.tunnelState = 'disabled';
    this.tunnelError = null;
    this.tunnelChild = null;
    this.tunnelKeyCopy = null;
    this.expectedStops = new WeakSet();
    this.lastProbe = { checkedAt: null, connected: false, error: 'Not checked yet' };
    this.switchPromise = null;
  }

  definition(name = this.currentEnvironment) {
    return this.config[name];
  }

  async probePrometheus(name = this.currentEnvironment) {
    const definition = this.definition(name);
    const url = new URL('/api/v1/query', `${definition.prometheusUrl.replace(/\/$/, '')}/`);
    url.searchParams.set('query', 'vector(1)');
    let connected = false;
    let error = null;
    try {
      const response = await this.fetch(url, { signal: AbortSignal.timeout(3000), headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error();
      const payload = await response.json();
      connected = payload?.status === 'success' && Array.isArray(payload?.data?.result)
        && payload.data.result.length > 0 && Number(payload.data.result[0]?.value?.[1]) === 1;
      if (!connected) error = 'Prometheus query API returned no valid response.';
    } catch {
      error = 'Prometheus is not reachable for the selected environment.';
    }
    if (name === this.currentEnvironment) this.lastProbe = { checkedAt: new Date().toISOString(), connected, error };
    return { connected, error, checkedAt: new Date().toISOString() };
  }

  snapshot() {
    const definition = this.definition();
    return {
      environment: this.currentEnvironment,
      backendTarget: definition.backendTarget,
      prometheusUrl: definition.prometheusUrl,
      prometheusConnected: this.lastProbe.connected,
      prometheusCheckedAt: this.lastProbe.checkedAt,
      prometheusError: this.lastProbe.error,
      tunnelStatus: this.currentEnvironment === 'local' ? 'disabled' : this.tunnelState,
      tunnelError: this.currentEnvironment === 'production' ? this.tunnelError : null,
      switching: this.switching,
    };
  }

  async status() {
    await this.probePrometheus();
    return this.snapshot();
  }

  async startTunnel() {
    if (this.tunnelChild && !this.tunnelChild.closed) return;
    if (this.startPromise) return this.startPromise;
    const pending = this.startTunnelOnce();
    this.startPromise = pending;
    try { return await pending; }
    finally { if (this.startPromise === pending) this.startPromise = null; }
  }

  async startTunnelOnce() {
    const ssh = this.config.ssh;
    try { createSshArguments(this.config, ssh.keyPath); }
    catch (error) { throw httpError(503, 'SSH_CONFIGURATION_INVALID', error.message); }
    let key;
    let knownHosts;
    try {
      [key, knownHosts] = await Promise.all([
        this.fs.readFile(ssh.keyPath),
        this.fs.readFile(ssh.knownHostsPath, 'utf8'),
      ]);
    } catch {
      throw httpError(503, 'SSH_CREDENTIALS_UNAVAILABLE', 'Production SSH key or verified known_hosts file is unavailable inside the Performance Lab container.');
    }
    if (!key.length || !knownHosts.trim()) throw httpError(503, 'SSH_CREDENTIALS_UNAVAILABLE', 'Production SSH key and verified known_hosts file must both contain data.');

    this.tunnelState = 'connecting';
    this.tunnelError = null;
    this.tunnelKeyCopy = path.join(os.tmpdir(), `sfm-performance-lab-ssh-${crypto.randomUUID()}`);
    try {
      await this.fs.writeFile(this.tunnelKeyCopy, key, { mode: 0o600, flag: 'wx' });
    } catch {
      this.tunnelState = 'error';
      this.tunnelKeyCopy = null;
      throw httpError(503, 'SSH_KEY_PREPARATION_FAILED', 'Could not prepare the SSH identity in the container temporary filesystem.');
    }

    let args;
    try { args = createSshArguments(this.config, this.tunnelKeyCopy); }
    catch (error) {
      await this.removeKeyCopy();
      this.tunnelState = 'error';
      throw httpError(503, 'SSH_CONFIGURATION_INVALID', error.message);
    }

    try {
      const child = this.spawn('ssh', args, { shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
      this.tunnelChild = child;
      const spawned = new Promise((resolve, reject) => {
        let settled = false;
        const settle = (callback, value) => { if (!settled) { settled = true; callback(value); } };
        child.once('spawn', () => settle(resolve));
        child.once('error', () => {
          this.onTunnelExit(child, null, 'error');
          settle(reject, httpError(503, 'SSH_START_FAILED', 'Could not start the SSH tunnel process.'));
        });
        child.once('close', (code, signal) => {
          this.onTunnelExit(child, code, signal);
          if (!settled) settle(reject, httpError(503, 'SSH_TUNNEL_EXITED', 'SSH tunnel exited before Prometheus became reachable.'));
        });
      });
      await spawned;
    } catch (error) {
      if (error.status) throw error;
      await this.removeKeyCopy();
      this.tunnelState = 'error';
      throw httpError(503, 'SSH_START_FAILED', 'Could not start the SSH tunnel process.');
    }
  }

  onTunnelExit(child, code, signal) {
    if (child.closed) return;
    child.closed = true;
    const expected = this.expectedStops.has(child);
    if (this.tunnelChild === child) this.tunnelChild = null;
    if (expected) {
      if (this.currentEnvironment === 'local') this.tunnelState = 'disabled';
    } else {
      this.tunnelState = 'error';
      this.tunnelError = `SSH tunnel exited unexpectedly (code ${code ?? 'unknown'}, signal ${signal ?? 'none'}).`;
    }
    void this.removeKeyCopy();
  }

  async removeKeyCopy() {
    const keyPath = this.tunnelKeyCopy;
    this.tunnelKeyCopy = null;
    if (keyPath) await this.fs.rm(keyPath, { force: true }).catch(() => {});
  }

  async stopTunnel() {
    const child = this.tunnelChild;
    if (!child || child.closed) {
      this.tunnelChild = null;
      await this.removeKeyCopy();
      this.tunnelState = 'disabled';
      return;
    }
    this.expectedStops.add(child);
    this.tunnelState = 'stopping';
    const closed = new Promise((resolve) => child.once('close', resolve));
    try { child.kill('SIGTERM'); } catch { /* close or force-kill below */ }
    const forceTimer = setTimeout(() => {
      if (!child.closed) { try { child.kill('SIGKILL'); } catch { /* process may have exited */ } }
    }, 3000);
    forceTimer.unref?.();
    await closed;
    clearTimeout(forceTimer);
    await this.removeKeyCopy();
    this.tunnelState = 'disabled';
  }

  async waitForProductionPrometheus() {
    const deadline = Date.now() + 12000;
    let lastError = null;
    while (Date.now() < deadline) {
      if (!this.tunnelChild || this.tunnelChild.closed) throw httpError(503, 'SSH_TUNNEL_EXITED', this.tunnelError || 'SSH tunnel exited before Prometheus became reachable.');
      const check = await this.probePrometheus('production');
      if (check.connected) {
        this.tunnelState = 'connected';
        this.tunnelError = null;
        return;
      }
      lastError = check.error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw httpError(503, 'PROMETHEUS_UNAVAILABLE', lastError || 'Production Prometheus was not reachable through the SSH tunnel.');
  }

  async switchTo(name) {
    if (!['local', 'production'].includes(name)) throw httpError(400, 'INVALID_ENVIRONMENT', 'Environment must be local or production.');
    if (this.switchPromise) throw httpError(409, 'ENVIRONMENT_SWITCH_IN_PROGRESS', 'An environment switch is already in progress.');
    if (name === this.currentEnvironment && !this.switching) {
      if (name === 'production') {
        await this.startTunnel();
        await this.waitForProductionPrometheus();
      } else {
        const check = await this.probePrometheus('local');
        if (!check.connected) throw httpError(503, 'PROMETHEUS_UNAVAILABLE', check.error);
      }
      return this.snapshot();
    }

    this.switching = true;
    this.switchPromise = (async () => {
      const previous = this.currentEnvironment;
      try {
        if (name === 'production') {
          await this.startTunnel();
          await this.waitForProductionPrometheus();
          this.currentEnvironment = 'production';
        } else {
          const check = await this.probePrometheus('local');
          if (!check.connected) throw httpError(503, 'PROMETHEUS_UNAVAILABLE', check.error);
          this.currentEnvironment = 'local';
          await this.stopTunnel();
        }
        this.lastProbe = { checkedAt: new Date().toISOString(), connected: true, error: null };
        return this.snapshot();
      } catch (error) {
        this.currentEnvironment = previous;
        if (name === 'production' && previous === 'local') await this.stopTunnel();
        throw error;
      } finally {
        this.switching = false;
        this.switchPromise = null;
      }
    })();
    return this.switchPromise;
  }

  async check(name = this.currentEnvironment) {
    if (!['local', 'production'].includes(name)) throw httpError(400, 'INVALID_ENVIRONMENT', 'Environment must be local or production.');
    if (name === 'production') {
      if (!this.tunnelChild || this.tunnelChild.closed) return { environment: name, connected: false, tunnelStatus: this.tunnelState, checkedAt: new Date().toISOString(), error: this.tunnelError || 'SSH tunnel is not connected.' };
      const result = await this.probePrometheus(name);
      if (result.connected) this.tunnelState = 'connected';
      return { environment: name, connected: result.connected, tunnelStatus: this.tunnelState, checkedAt: result.checkedAt, error: result.error };
    }
    const result = await this.probePrometheus(name);
    return { environment: name, connected: result.connected, tunnelStatus: 'disabled', checkedAt: result.checkedAt, error: result.error };
  }

  async dispose() {
    await this.stopTunnel();
  }
}

module.exports = { EnvironmentManager, httpError };
