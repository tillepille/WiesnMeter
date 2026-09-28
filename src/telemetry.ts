import { MeterProvider, PeriodicExportingMetricReader, ConsoleMetricExporter } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { Counter } from '@opentelemetry/api';

export interface TelemetryConfig {
  serviceName: string;
  otlpEndpoint: string;
  exporterType: 'otlp' | 'console' | 'both';
  exportIntervalMillis: number;
  hasAuth: boolean;
}

export interface TelemetryInitOptions extends Partial<TelemetryConfig> {
  headers?: Record<string, string>;
}

let meterProvider: MeterProvider | null = null;
let drinksCounter: Counter | null = null;

// In-memory counter for real-time app UI session stats
const userDrinkStats = new Map<string, { beer: number; schnaps: number }>();

/**
 * Normalizes OTLP HTTP metrics endpoint.
 * Ensures URL does not end with trailing slash and points to /v1/metrics
 * e.g.:
 * - https://otlp-gateway-prod-eu-west-0.grafana.net/otlp -> https://otlp-gateway-prod-eu-west-0.grafana.net/otlp/v1/metrics
 * - https://otlp-gateway-prod-eu-west-0.grafana.net/otlp/v1/metrics -> https://otlp-gateway-prod-eu-west-0.grafana.net/otlp/v1/metrics
 * - http://localhost:4318 -> http://localhost:4318/v1/metrics
 */
export function normalizeOtlpEndpoint(endpoint: string): string {
  let url = endpoint.trim().replace(/\/+$/, '');
  if (!url.endsWith('/v1/metrics')) {
    url = `${url}/v1/metrics`;
  }
  return url;
}

/**
 * Parses comma-separated key=value header strings (OpenTelemetry standard)
 * e.g.: "Authorization=Basic abc,X-Custom=123"
 */
export function parseHeadersString(headerStr?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!headerStr) return headers;

  const parts = headerStr.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && val) {
        headers[key] = val;
      }
    }
  }
  return headers;
}

/**
 * Resolves authentication and custom headers for OTLP export.
 * Priority order for Authorization header:
 * 1. Grafana Cloud credentials (GRAFANA_CLOUD_INSTANCE_ID + GRAFANA_CLOUD_API_TOKEN) -> Basic base64(instance:token)
 * 2. Generic OTLP credentials (OTEL_EXPORTER_OTLP_AUTH_USER + OTEL_EXPORTER_OTLP_AUTH_PASSWORD) -> Basic base64(user:pass)
 * 3. Direct Authorization header (OTEL_EXPORTER_OTLP_AUTH_HEADER)
 * 4. OpenTelemetry standard header env vars (OTEL_EXPORTER_OTLP_METRICS_HEADERS, OTEL_EXPORTER_OTLP_HEADERS)
 */
export function getTelemetryHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  // 1. Parse standard OpenTelemetry headers environment variables
  if (process.env.OTEL_EXPORTER_OTLP_HEADERS) {
    Object.assign(headers, parseHeadersString(process.env.OTEL_EXPORTER_OTLP_HEADERS));
  }
  if (process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS) {
    Object.assign(headers, parseHeadersString(process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS));
  }

  // 2. Direct Authorization header if specified
  if (process.env.OTEL_EXPORTER_OTLP_AUTH_HEADER) {
    headers['Authorization'] = process.env.OTEL_EXPORTER_OTLP_AUTH_HEADER.trim();
  }

  // 3. Generic OTLP username + password
  const oTelUser = process.env.OTEL_EXPORTER_OTLP_AUTH_USER || process.env.OTEL_EXPORTER_OTLP_USERNAME;
  const oTelPass = process.env.OTEL_EXPORTER_OTLP_AUTH_PASSWORD || process.env.OTEL_EXPORTER_OTLP_PASSWORD;
  if (oTelUser && oTelPass) {
    const basicAuth = Buffer.from(`${oTelUser.trim()}:${oTelPass.trim()}`).toString('base64');
    headers['Authorization'] = `Basic ${basicAuth}`;
  }

  // 4. Grafana Cloud Instance ID + API Token (Access Policy token with metrics:write)
  const grafanaInstanceId =
    process.env.GRAFANA_CLOUD_INSTANCE_ID || process.env.GRAFANA_INSTANCE_ID;
  const grafanaApiToken =
    process.env.GRAFANA_CLOUD_API_TOKEN ||
    process.env.GRAFANA_CLOUD_API_KEY ||
    process.env.GRAFANA_API_KEY ||
    process.env.GRAFANA_API_TOKEN;

  if (grafanaInstanceId && grafanaApiToken) {
    const basicAuth = Buffer.from(
      `${grafanaInstanceId.trim()}:${grafanaApiToken.trim()}`
    ).toString('base64');
    headers['Authorization'] = `Basic ${basicAuth}`;
  }

  return headers;
}

export function getTelemetryConfig(): TelemetryConfig {
  const serviceName = process.env.OTEL_SERVICE_NAME || 'wiesnmeter';
  const rawEndpoint =
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
    process.env.GRAFANA_CLOUD_OTLP_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    'https://otlp-gateway-prod-eu-west-0.grafana.net/otlp';

  const otlpEndpoint = normalizeOtlpEndpoint(rawEndpoint);

  const exporterType = (process.env.OTEL_METRICS_EXPORTER || 'otlp').toLowerCase() as
    | 'otlp'
    | 'console'
    | 'both';

  const exportIntervalMillis = parseInt(
    process.env.OTEL_METRIC_EXPORT_INTERVAL || '5000',
    10
  );

  const headers = getTelemetryHeaders();
  const hasAuth = Boolean(headers['Authorization'] || headers['authorization']);

  return {
    serviceName,
    otlpEndpoint,
    exporterType,
    exportIntervalMillis,
    hasAuth,
  };
}

export function initTelemetry(options?: TelemetryInitOptions) {
  const baseConfig = getTelemetryConfig();
  const config: TelemetryConfig = {
    serviceName: options?.serviceName ?? baseConfig.serviceName,
    otlpEndpoint: options?.otlpEndpoint ? normalizeOtlpEndpoint(options.otlpEndpoint) : baseConfig.otlpEndpoint,
    exporterType: options?.exporterType ?? baseConfig.exporterType,
    exportIntervalMillis: options?.exportIntervalMillis ?? baseConfig.exportIntervalMillis,
    hasAuth: options?.hasAuth ?? baseConfig.hasAuth,
  };

  const headers = {
    ...getTelemetryHeaders(),
    ...(options?.headers || {}),
  };
  const hasAuth = Boolean(headers['Authorization'] || headers['authorization']);
  config.hasAuth = hasAuth;

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
  });

  const readers = [];

  if (config.exporterType === 'console' || config.exporterType === 'both') {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new ConsoleMetricExporter(),
        exportIntervalMillis: config.exportIntervalMillis,
      })
    );
  }

  if (config.exporterType === 'otlp' || config.exporterType === 'both') {
    if (!hasAuth && config.otlpEndpoint.includes('grafana.net')) {
      console.warn(
        '[Telemetry] Warning: Exporting to Grafana Cloud without authentication credentials. Set GRAFANA_CLOUD_INSTANCE_ID and GRAFANA_CLOUD_API_TOKEN in your environment.'
      );
    }

    const otlpExporter = new OTLPMetricExporter({
      url: config.otlpEndpoint,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });

    readers.push(
      new PeriodicExportingMetricReader({
        exporter: otlpExporter,
        exportIntervalMillis: config.exportIntervalMillis,
      })
    );
  }

  meterProvider = new MeterProvider({
    resource,
    readers,
  });

  const meter = meterProvider.getMeter('wiesnmeter');

  drinksCounter = meter.createCounter('drinks_total', {
    description: 'Total number of drinks logged per user and type',
    unit: '{drinks}',
  });

  console.log(
    `[Telemetry] Initialized for service "${config.serviceName}" with exporter "${config.exporterType}" (endpoint: ${config.otlpEndpoint}, auth: ${hasAuth ? 'enabled' : 'none'})`
  );

  return { meterProvider, drinksCounter };
}

export function recordDrink(username: string, type: 'beer' | 'schnaps' | string, count: number = 1) {
  if (!drinksCounter) {
    initTelemetry();
  }

  // Normalize drink type (e.g. "mass" -> "beer")
  const normalizedType = type === 'mass' ? 'beer' : type;

  // Record OpenTelemetry metric with labels 'username' and 'type'
  drinksCounter?.add(count, {
    username,
    type: normalizedType,
  });

  // Track in-memory stats for user UI
  const stats = userDrinkStats.get(username) || { beer: 0, schnaps: 0 };
  if (normalizedType === 'beer') {
    stats.beer += count;
  } else if (normalizedType === 'schnaps') {
    stats.schnaps += count;
  }
  userDrinkStats.set(username, stats);

  console.log(`[Telemetry] Recorded metric: drinks_total +${count} { username: "${username}", type: "${normalizedType}" }`);

  return {
    username,
    type: normalizedType,
    stats,
  };
}

export function getUserStats(username: string) {
  return userDrinkStats.get(username) || { beer: 0, schnaps: 0 };
}

export async function flushTelemetry(): Promise<void> {
  if (meterProvider) {
    await meterProvider.forceFlush();
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (meterProvider) {
    await meterProvider.shutdown();
    meterProvider = null;
    drinksCounter = null;
  }
}
