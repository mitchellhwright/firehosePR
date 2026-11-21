#!/usr/bin/env node

import { appendFileSync, closeSync, openSync } from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid listen port: ${value}`);
  }
  return port;
}

const listenHost = process.env.DASHBOARD_OFFLINE_PROXY_HOST?.trim() || '127.0.0.1';
const listenPort = parsePort(process.env.DASHBOARD_OFFLINE_PROXY_PORT?.trim() || '3001');
const upstream = new URL(requiredEnvironment('DASHBOARD_OFFLINE_PROXY_UPSTREAM'));
const controlToken = requiredEnvironment('DASHBOARD_OFFLINE_PROXY_CONTROL_TOKEN');
const commitSha = requiredEnvironment('DASHBOARD_OFFLINE_PROXY_COMMIT_SHA');
const evidencePath = requiredEnvironment('DASHBOARD_OFFLINE_PROXY_EVENTS');
const minimumAutomaticFailureCount = 4;
const minimumPreArmQuiescenceMilliseconds = 11_000;

if (listenHost !== '127.0.0.1') {
  throw new Error('Dashboard offline proxy must bind to 127.0.0.1');
}
if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1') {
  throw new Error('Dashboard offline proxy only accepts a loopback HTTP upstream');
}
if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
  throw new Error('DASHBOARD_OFFLINE_PROXY_COMMIT_SHA must be a full Git SHA');
}
if (controlToken.length < 32) {
  throw new Error('DASHBOARD_OFFLINE_PROXY_CONTROL_TOKEN must contain at least 32 characters');
}

closeSync(openSync(evidencePath, 'wx', 0o600));

let sequence = 0;
let armed = false;
let forcedFailureCount = 0;
let forwardedDashboardCount = 0;
let completedDashboardForwardCount = 0;
let activeDashboardForwardCount = 0;
let successfulDashboardForwardCount = 0;
let lastDashboardActivityAt: number | null = null;

function record(event: string, details: Readonly<Record<string, unknown>> = {}): void {
  sequence += 1;
  appendFileSync(
    evidencePath,
    `${JSON.stringify({
      sequence,
      event,
      commitSha,
      timestamp: new Date().toISOString(),
      ...details,
    })}\n`,
    { mode: 0o600 },
  );
}

function jsonResponse(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json',
  });
  response.end(body);
}

function authorized(request: IncomingMessage): boolean {
  return request.headers['x-example-e2e-control'] === controlToken;
}

function statusPayload(): Readonly<{
  ready: true;
  armed: boolean;
  minimumAutomaticFailureCount: number;
  forcedFailureCount: number;
  forwardedDashboardCount: number;
  completedDashboardForwardCount: number;
  activeDashboardForwardCount: number;
  successfulDashboardForwardCount: number;
  minimumPreArmQuiescenceMilliseconds: number;
  dashboardQuiescentMilliseconds: number;
  commitSha: string;
}> {
  let dashboardQuiescentMilliseconds = 0;
  if (activeDashboardForwardCount === 0) {
    dashboardQuiescentMilliseconds = lastDashboardActivityAt === null
      ? minimumPreArmQuiescenceMilliseconds
      : Math.max(0, Date.now() - lastDashboardActivityAt);
  }
  return {
    ready: true,
    armed,
    minimumAutomaticFailureCount,
    forcedFailureCount,
    forwardedDashboardCount,
    completedDashboardForwardCount,
    activeDashboardForwardCount,
    successfulDashboardForwardCount,
    minimumPreArmQuiescenceMilliseconds,
    dashboardQuiescentMilliseconds,
    commitSha,
  };
}

function handleControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): boolean {
  if (pathname === '/__example_e2e/health' && request.method === 'GET') {
    jsonResponse(response, 200, { ready: true, commitSha });
    return true;
  }

  if (!pathname.startsWith('/__example_e2e/')) {
    return false;
  }
  if (!authorized(request)) {
    jsonResponse(response, 403, { error: 'Forbidden' });
    return true;
  }

  if (pathname === '/__example_e2e/dashboard-offline-once' && request.method === 'POST') {
    if (armed || forcedFailureCount > 0) {
      jsonResponse(response, 409, { error: 'Dashboard fault is already armed or consumed' });
      return true;
    }
    const preArmStatus = statusPayload();
    if (
      preArmStatus.activeDashboardForwardCount !== 0
      || preArmStatus.completedDashboardForwardCount
        !== preArmStatus.forwardedDashboardCount
      || preArmStatus.dashboardQuiescentMilliseconds
        < minimumPreArmQuiescenceMilliseconds
    ) {
      jsonResponse(response, 409, {
        error: 'Dashboard traffic is not quiescent',
        ...preArmStatus,
      });
      return true;
    }
    armed = true;
    record('dashboard_fault_armed', {
      minimumAutomaticFailureCount,
      minimumPreArmQuiescenceMilliseconds,
      preArmQuiescentMilliseconds:
        preArmStatus.dashboardQuiescentMilliseconds,
      preArmForwardedDashboardCount:
        preArmStatus.forwardedDashboardCount,
      preArmCompletedDashboardForwardCount:
        preArmStatus.completedDashboardForwardCount,
      preArmActiveDashboardForwardCount:
        preArmStatus.activeDashboardForwardCount,
    });
    jsonResponse(response, 200, statusPayload());
    return true;
  }

  if (pathname === '/__example_e2e/dashboard-online' && request.method === 'POST') {
    if (!armed) {
      jsonResponse(response, 409, { error: 'Dashboard fault is not armed' });
      return true;
    }
    if (forcedFailureCount < minimumAutomaticFailureCount) {
      jsonResponse(response, 409, {
        error: 'Dashboard automatic retries have not been exercised',
        ...statusPayload(),
      });
      return true;
    }
    armed = false;
    record('dashboard_fault_released', {
      forcedFailureCount,
      minimumAutomaticFailureCount,
    });
    jsonResponse(response, 200, statusPayload());
    return true;
  }

  if (pathname === '/__example_e2e/dashboard-offline-status' && request.method === 'GET') {
    jsonResponse(response, 200, statusPayload());
    return true;
  }

  jsonResponse(response, 404, { error: 'Not found' });
  return true;
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN';
}

function forwardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  isDashboardRequest: boolean,
): void {
  const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, upstream);
  let dashboardForwardSequence: number | undefined;
  let dashboardForwardSettled = false;
  if (isDashboardRequest) {
    forwardedDashboardCount += 1;
    activeDashboardForwardCount += 1;
    lastDashboardActivityAt = Date.now();
    dashboardForwardSequence = forwardedDashboardCount;
    record('dashboard_forward_started', {
      forwardedDashboardCount: dashboardForwardSequence,
      activeDashboardForwardCount,
      method: request.method,
      path: requestUrl.pathname,
    });
  }

  function settleDashboardForward(
    event: string,
    details: Readonly<Record<string, unknown>> = {},
  ): void {
    if (!isDashboardRequest || dashboardForwardSettled) return;
    dashboardForwardSettled = true;
    completedDashboardForwardCount += 1;
    activeDashboardForwardCount -= 1;
    lastDashboardActivityAt = Date.now();
    record(event, {
      forwardedDashboardCount: dashboardForwardSequence,
      completedDashboardForwardCount,
      activeDashboardForwardCount,
      ...details,
    });
  }

  const upstreamRequest = http.request(
    upstreamUrl,
    {
      method: request.method,
      headers: {
        ...request.headers,
        host: upstream.host,
      },
    },
    upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
      if (isDashboardRequest) {
        upstreamResponse.once('end', () => {
          const statusCode = upstreamResponse.statusCode ?? 502;
          if (statusCode >= 200 && statusCode < 300) {
            successfulDashboardForwardCount += 1;
          }
          settleDashboardForward('dashboard_forward_completed', {
            statusCode,
            successfulDashboardForwardCount,
          });
        });
        upstreamResponse.once('aborted', () => {
          settleDashboardForward('dashboard_forward_failed', {
            errorCode: 'UPSTREAM_RESPONSE_ABORTED',
          });
        });
      }
    },
  );

  upstreamRequest.on('error', error => {
    settleDashboardForward('dashboard_forward_failed', {
      errorCode: errorCode(error),
    });
    if (!response.headersSent) {
      jsonResponse(response, 502, { error: 'Development backend unavailable' });
    } else {
      response.destroy(error);
    }
  });
  request.pipe(upstreamRequest);
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (handleControlRequest(request, response, requestUrl.pathname)) {
    return;
  }

  const isDashboardRequest =
    request.method === 'GET' && requestUrl.pathname === '/api/dashboard';
  if (isDashboardRequest && armed) {
    forcedFailureCount += 1;
    record('dashboard_forced_unavailable', {
      forcedFailureCount,
      minimumAutomaticFailureCount,
      method: request.method,
      path: requestUrl.pathname,
      statusCode: 503,
    });
    jsonResponse(response, 503, {
      error: 'Dashboard temporarily unavailable for automated offline verification',
    });
    return;
  }

  forwardRequest(request, response, requestUrl, isDashboardRequest);
});

server.on('error', error => {
  record('proxy_error', { errorCode: errorCode(error) });
  throw error;
});

server.listen(listenPort, listenHost, () => {
  const address = server.address();
  const resolvedPort = typeof address === 'object' && address ? address.port : listenPort;
  record('proxy_started', {
    host: listenHost,
    port: resolvedPort,
    upstream: upstream.origin,
    minimumAutomaticFailureCount,
  });
  process.stdout.write(`${JSON.stringify({ ready: true, port: resolvedPort, commitSha })}\n`);
});

function shutdown(signal: NodeJS.Signals): void {
  record('proxy_stopping', { signal });
  server.close(error => {
    if (error) {
      record('proxy_stop_failed', { errorCode: errorCode(error) });
      process.exitCode = 1;
    } else {
      record('proxy_stopped');
    }
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
