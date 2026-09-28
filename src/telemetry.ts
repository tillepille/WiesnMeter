import { MeterProvider, PeriodicExportingMetricReader, ConsoleMetricExporter } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { Counter } from '@opentelemetry/api';

export interface TelemetryConfig {
  serviceName: string;
  otlpEndpoint?: string;
  exporterType: 'otlp' | 'console' | 'both';
  exportIntervalMillis: number;
}

let meterProvider: MeterProvider | null = null;
let drinksCounter: Counter | null = null;

// In-memory counter for real-time app UI session stats
const userDrinkStats = new Map<string, { beer: number; schnaps: number }>();

export function getTelemetryConfig(): TelemetryConfig {
  const serviceName = process.env.OTEL_SERVICE_NAME || 'wiesnmeter';
  const otlpEndpoint =
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    'http://localhost:4318/v1/metrics';
  
  const exporterType = (process.env.OTEL_METRICS_EXPORTER || 'otlp').toLowerCase() as
    | 'otlp'
    | 'console'
    | 'both';

  const exportIntervalMillis = parseInt(
    process.env.OTEL_METRIC_EXPORT_INTERVAL || '5000',
    10
  );

  return {
    serviceName,
    otlpEndpoint,
    exporterType,
    exportIntervalMillis,
  };
}

export function initTelemetry(configOverride?: Partial<TelemetryConfig>) {
  const config = { ...getTelemetryConfig(), ...configOverride };

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
    const otlpExporter = new OTLPMetricExporter({
      url: config.otlpEndpoint,
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
    `[Telemetry] Initialized for service "${config.serviceName}" with exporter "${config.exporterType}" (endpoint: ${config.otlpEndpoint})`
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
