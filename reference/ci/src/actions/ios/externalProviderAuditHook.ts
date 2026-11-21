import { chmodSync, closeSync, openSync, appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';

const auditPath = process.env.EXTERNAL_PROVIDER_AUDIT_LOG?.trim() ?? '';
const auditPolicy = process.env.EXTERNAL_PROVIDER_AUDIT_POLICY?.trim() ?? 'observe';
const auditSessionId = randomUUID();
let auditPhase = 'runtime';
const providerHosts: readonly (readonly [string, RegExp])[] = [
  ['plaid', /(^|\.)plaid\.com$/i],
  ['openai', /(^|\.)openai\.com$/i],
  ['anthropic', /(^|\.)anthropic\.com$/i],
  ['groq', /(^|\.)groq\.com$/i],
];
const enforcedBoundaries = ['dns', 'fetch', 'http', 'http2', 'https', 'net', 'tls', 'undici'];

// This preload is an API-level fence. Its receipt must not be interpreted as
// process-wide egress proof: native addons, previously captured references,
// custom dispatchers, resolved IPs, and child processes are outside its scope.

interface BoundaryRecord {
  readonly provider: string;
  readonly disposition: 'blocked' | 'allowed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function normalizedHostname(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/\.+$/, '');
}

function providerForHostname(hostname: unknown): string | null {
  const normalized = normalizedHostname(hostname);
  return providerHosts.find(([, pattern]) => pattern.test(normalized))?.[0] ?? null;
}

function providerForURL(value: unknown): string | null {
  try {
    const url = value instanceof URL ? value : new URL(String(value));
    return providerForHostname(url.hostname);
  } catch {
    return null;
  }
}

function requestURL(input: unknown, options: unknown, protocol: string): URL | null {
  if (input instanceof URL || typeof input === 'string') {
    try {
      return new URL(input, `${protocol}//localhost`);
    } catch {
      return null;
    }
  }
  const values = isRecord(input) ? input : options;
  if (!isRecord(values)) return null;
  const hostname = values.hostname ?? values.host;
  if (typeof hostname !== 'string' || hostname.length === 0) return null;
  const path = typeof values.path === 'string' ? values.path : '/';
  const port = values.port == null || values.port === '' ? '' : `:${values.port}`;
  try {
    return new URL(`${values.protocol ?? protocol}//${hostname}${port}${path}`);
  } catch {
    return null;
  }
}

function recordBoundary(url: URL | null, transport: string): BoundaryRecord | null {
  if (!auditPath || !url) return null;
  const provider = providerForURL(url);
  if (!provider) return null;
  const disposition = auditPolicy === 'block' ? 'blocked' : 'allowed';
  appendFileSync(auditPath, `${JSON.stringify({
    event: 'external_provider_boundary',
    provider,
    transport,
    host: normalizedHostname(url.hostname),
    method: 'attempt',
    disposition,
    phase: auditPhase,
    sessionId: auditSessionId,
    observedAt: new Date().toISOString(),
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  return { provider, disposition };
}

function recordHostnameBoundary(hostname: unknown, transport: string): BoundaryRecord | null {
  const normalized = normalizedHostname(hostname);
  if (!normalized) return null;
  try {
    return recordBoundary(new URL(`https://${normalized}`), transport);
  } catch {
    return null;
  }
}

function blockedProviderError(provider: string, transport: string): Error & { readonly code: string } {
  return Object.assign(
    new Error(`External provider ${provider} blocked by the E2E network policy (${transport})`),
    { code: 'ERR_EXTERNAL_PROVIDER_BLOCKED' },
  );
}

if (auditPath) {
  closeSync(openSync(auditPath, 'a', 0o600));
  chmodSync(auditPath, 0o600);

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    globalThis.fetch = function auditedFetch(input, init) {
      const rawURL = typeof input === 'object' && input !== null && 'url' in input ? input.url : input;
      let url = null;
      try { url = new URL(String(rawURL)); } catch { /* The original fetch reports invalid input. */ }
      const boundary = recordBoundary(url, 'fetch');
      if (boundary?.disposition === 'blocked') {
        return Promise.reject(blockedProviderError(boundary.provider, 'fetch'));
      }
      return originalFetch.call(this, input, init);
    };
  }

  const require = createRequire(import.meta.url);
  const Module = require('node:module');

  const dns = require('node:dns');
  for (const methodName of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) {
    const original = dns[methodName];
    if (typeof original !== 'function') continue;
    dns[methodName] = function auditedDNS(hostname: unknown, ...args: unknown[]) {
      const boundary = recordHostnameBoundary(hostname, `dns:${methodName}`);
      if (boundary?.disposition === 'blocked') {
        const error = blockedProviderError(boundary.provider, `dns:${methodName}`);
        const callback = [...args].reverse().find(
          (value): value is (...callbackArgs: unknown[]) => unknown => typeof value === 'function',
        );
        if (callback) {
          queueMicrotask(() => callback(error));
          return;
        }
        throw error;
      }
      return original.call(this, hostname, ...args);
    };
  }
  for (const methodName of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) {
    const original = dns.promises?.[methodName];
    if (typeof original !== 'function') continue;
    dns.promises[methodName] = async function auditedDNSPromise(hostname: unknown, ...args: unknown[]) {
      const boundary = recordHostnameBoundary(hostname, `dns:promises.${methodName}`);
      if (boundary?.disposition === 'blocked') {
        throw blockedProviderError(boundary.provider, `dns:promises.${methodName}`);
      }
      return original.call(this, hostname, ...args);
    };
  }

  const net = require('node:net');
  const originalSocketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function auditedSocketConnect(...args: unknown[]) {
    const options = isRecord(args[0]) ? args[0] : null;
    const hostname = options?.host ?? options?.hostname
      ?? (typeof args[1] === 'string' ? args[1] : null);
    const boundary = recordHostnameBoundary(hostname, 'net:Socket.connect');
    if (boundary?.disposition === 'blocked') {
      throw blockedProviderError(boundary.provider, 'net:Socket.connect');
    }
    return originalSocketConnect.apply(this, args);
  };
  for (const methodName of ['connect', 'createConnection']) {
    const original = net[methodName];
    net[methodName] = function auditedNetConnect(...args: unknown[]) {
      const options = isRecord(args[0]) ? args[0] : null;
      const hostname = options?.host ?? options?.hostname
        ?? (typeof args[1] === 'string' ? args[1] : null);
      const boundary = recordHostnameBoundary(hostname, `net:${methodName}`);
      if (boundary?.disposition === 'blocked') {
        throw blockedProviderError(boundary.provider, `net:${methodName}`);
      }
      return original.apply(this, args);
    };
  }

  const tls = require('node:tls');
  const originalTLSConnect = tls.connect;
  tls.connect = function auditedTLSConnect(...args: unknown[]) {
    const options = args.find((value): value is Record<string, unknown> => (
      isRecord(value) && !(value instanceof URL)
    ));
    const hostname = options?.servername ?? options?.host ?? options?.hostname
      ?? (typeof args[1] === 'string' ? args[1] : null);
    const boundary = recordHostnameBoundary(hostname, 'tls:connect');
    if (boundary?.disposition === 'blocked') {
      throw blockedProviderError(boundary.provider, 'tls:connect');
    }
    return originalTLSConnect.apply(this, args);
  };

  const http2 = require('node:http2');
  const originalHTTP2Connect = http2.connect;
  http2.connect = function auditedHTTP2Connect(authority: unknown, ...args: unknown[]) {
    let url = null;
    try { url = authority instanceof URL ? authority : new URL(String(authority)); } catch { /* Original reports it. */ }
    const boundary = recordBoundary(url, 'http2:connect');
    if (boundary?.disposition === 'blocked') {
      throw blockedProviderError(boundary.provider, 'http2:connect');
    }
    return originalHTTP2Connect.call(this, authority, ...args);
  };

  const undiciMethods = ['request', 'stream', 'pipeline', 'connect', 'upgrade'];
  const patchedUndici = new WeakSet<object>();
  function patchUndiciExports(moduleExports: unknown): Record<string, unknown> {
    if (!isRecord(moduleExports)) {
      throw new Error('Undici exports must be an object');
    }
    if (patchedUndici.has(moduleExports)) return moduleExports;
    patchedUndici.add(moduleExports);
    for (const methodName of undiciMethods) {
      const original = moduleExports[methodName];
      if (typeof original !== 'function') continue;
      moduleExports[methodName] = function auditedUndici(origin: unknown, ...args: unknown[]) {
        let url = null;
        try { url = origin instanceof URL ? origin : new URL(String(origin)); } catch { /* Original reports it. */ }
        const boundary = recordBoundary(url, `undici:${methodName}`);
        if (boundary?.disposition === 'blocked') {
          return Promise.reject(blockedProviderError(boundary.provider, `undici:${methodName}`));
        }
        return Reflect.apply(original, this, [origin, ...args]);
      };
    }
    return moduleExports;
  }

  const originalModuleLoad = Module._load;
  Module._load = function auditedModuleLoad(request: string, parent: unknown, isMain: boolean) {
    const moduleExports: unknown = originalModuleLoad.call(this, request, parent, isMain);
    return request === 'undici' ? patchUndiciExports(moduleExports) : moduleExports;
  };
  let undici: Record<string, unknown>;
  try {
    undici = patchUndiciExports(require('undici'));
  } catch (error) {
    throw new Error('Income E2E provider fence could not load Undici for startup coverage', { cause: error });
  }

  for (const [moduleName, protocol] of [
    ['node:http', 'http:'],
    ['node:https', 'https:'],
  ] as const) {
    const client = require(moduleName);
    for (const methodName of ['request', 'get']) {
      const original = client[methodName];
      client[methodName] = function auditedRequest(...args: unknown[]) {
        const transport = `${protocol}${methodName}`;
        const boundary = recordBoundary(requestURL(args[0], args[1], protocol), transport);
        if (boundary?.disposition === 'blocked') {
          throw blockedProviderError(boundary.provider, transport);
        }
        return original.apply(this, args);
      };
    }
  }
  syncBuiltinESMExports();

  async function expectStartupBlock(
    transport: string,
    operation: () => unknown | Promise<unknown>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (isRecord(error) && error.code === 'ERR_EXTERNAL_PROVIDER_BLOCKED') return;
      throw new Error(`Income E2E provider fence ${transport} probe failed unexpectedly`, { cause: error });
    }
    throw new Error(`Income E2E provider fence ${transport} probe reached its transport`);
  }
  if (auditPolicy === 'block') {
    auditPhase = 'startup_probe';
    const http = require('node:http');
    const https = require('node:https');
    await expectStartupBlock('fetch', () => globalThis.fetch('https://api.openai.com./v1/models'));
    await expectStartupBlock('http', () => http.request('http://api.openai.com./v1/models'));
    await expectStartupBlock('https', () => https.request('https://api.openai.com./v1/models'));
    await expectStartupBlock('http2', () => http2.connect('https://api.openai.com.'));
    await expectStartupBlock('net', () => net.connect({ host: 'api.openai.com.', port: 443 }));
    await expectStartupBlock('tls', () => tls.connect({ host: 'api.openai.com.', port: 443 }));
    await expectStartupBlock('dns', () => dns.promises.lookup('api.openai.com.'));
    const undiciRequest = undici.request;
    if (typeof undiciRequest !== 'function') {
      throw new Error('Income E2E provider fence requires Undici request()');
    }
    await expectStartupBlock('undici', () => (
      Reflect.apply(undiciRequest, undici, ['https://api.openai.com./v1/models'])
    ));
    auditPhase = 'runtime';
  }

  appendFileSync(auditPath, `${JSON.stringify({
    event: 'external_provider_boundary_coverage',
    sessionId: auditSessionId,
    policy: auditPolicy,
    instrumentedBoundaries: enforcedBoundaries,
    startupProbesPassed: auditPolicy === 'block',
    observedAt: new Date().toISOString(),
  })}\n`, { encoding: 'utf8', mode: 0o600 });
}
