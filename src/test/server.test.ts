import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'http';

// Ensure test environment
process.env.NODE_ENV = 'test';
process.env.DEV_MODE = 'true';
process.env.OTEL_METRICS_EXPORTER = 'console';
process.env.OTEL_METRIC_EXPORT_INTERVAL = '60000';

import { app } from '../server.js';
import { shutdownTelemetry } from '../telemetry.js';

describe('WiesnMeter API & Telemetry Tests', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr !== null) {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await shutdownTelemetry();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  test('GET /healthz returns ok status and telemetry configuration', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'wiesnmeter');
    assert.ok(body.telemetry);
    assert.equal(body.telemetry.serviceName, 'wiesnmeter');
  });

  test('GET /api/me returns unauthenticated initially', async () => {
    const res = await fetch(`${baseUrl}/api/me`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.authenticated, false);
  });

  test('POST /api/track fails with 401 when not authenticated', async () => {
    const res = await fetch(`${baseUrl}/api/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'beer' }),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as any;
    assert.ok(body.error.includes('Unauthorized'));
  });

  test('POST /login/dev and tracking drinks with OpenTelemetry labels', async () => {
    // 1. Log in via dev login
    const loginRes = await fetch(`${baseUrl}/login/dev`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'sepp_wiesn' }),
    });
    assert.equal(loginRes.status, 200);
    const loginData = (await loginRes.json()) as any;
    assert.equal(loginData.success, true);
    assert.equal(loginData.user.username, 'sepp_wiesn');

    // Extract all session cookies (wiesn_session and wiesn_session.sig)
    const setCookies = loginRes.headers.getSetCookie();
    assert.ok(setCookies.length > 0, 'Should receive session cookies');
    const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');

    // 2. Check /api/me with session cookie
    const meRes = await fetch(`${baseUrl}/api/me`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(meRes.status, 200);
    const meData = (await meRes.json()) as any;
    assert.equal(meData.authenticated, true);
    assert.equal(meData.user.username, 'sepp_wiesn');

    // 3. Track one Maß (beer)
    const trackMassRes = await fetch(`${baseUrl}/api/track`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ type: 'beer' }),
    });
    assert.equal(trackMassRes.status, 200);
    const trackMassData = (await trackMassRes.json()) as any;
    assert.equal(trackMassData.success, true);
    assert.equal(trackMassData.data.username, 'sepp_wiesn');
    assert.equal(trackMassData.data.type, 'beer');
    assert.equal(trackMassData.data.stats.beer, 1);

    // 4. Track one Schnaps
    const trackSchnapsRes = await fetch(`${baseUrl}/api/track`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ type: 'schnaps' }),
    });
    assert.equal(trackSchnapsRes.status, 200);
    const trackSchnapsData = (await trackSchnapsRes.json()) as any;
    assert.equal(trackSchnapsData.success, true);
    assert.equal(trackSchnapsData.data.username, 'sepp_wiesn');
    assert.equal(trackSchnapsData.data.type, 'schnaps');
    assert.equal(trackSchnapsData.data.stats.schnaps, 1);
    assert.equal(trackSchnapsData.data.stats.beer, 1);

    // 5. Test invalid drink type
    const invalidRes = await fetch(`${baseUrl}/api/track`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ type: 'water' }),
    });
    assert.equal(invalidRes.status, 400);

    // 6. Test logout
    const logoutRes = await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: { Cookie: cookieHeader },
    });
    assert.equal(logoutRes.status, 200);
  });
});
