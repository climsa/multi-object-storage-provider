import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

type RequestMetric = { method: string; route: string; status: number };
type DurationMetric = { count: number; sumSeconds: number; maxSeconds: number };

export class MetricsRegistry {
  private readonly requests = new Map<string, number>();
  private readonly durations = new Map<string, { count: number; sumSeconds: number }>();
  private readonly namedDurations = new Map<string, DurationMetric>();
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  public observeRequest(metric: RequestMetric, durationSeconds: number): void {
    const key = `${metric.method}|${metric.route}|${metric.status}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    const durationKey = `${metric.method}|${metric.route}`;
    const current = this.durations.get(durationKey) ?? { count: 0, sumSeconds: 0 };
    current.count += 1;
    current.sumSeconds += durationSeconds;
    this.durations.set(durationKey, current);
  }

  public observeMiddleware(request: Request, response: Response, startedAt: bigint): void {
    response.once("finish", () => {
      const route = typeof request.route?.path === "string"
        ? `${request.baseUrl}${request.route.path}`
        : "unmatched";
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      this.observeRequest({ method: request.method, route, status: response.statusCode }, durationSeconds);
    });
  }

  public incrementCounter(name: string, value = 1): void {
    assertMetricName(name);
    if (!Number.isFinite(value) || value < 0) throw new RangeError("Metric increment must be non-negative");
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  public observeDuration(name: string, durationSeconds: number): void {
    assertMetricName(name);
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
      throw new RangeError("Metric duration must be non-negative");
    }
    const current = this.namedDurations.get(name) ?? { count: 0, sumSeconds: 0, maxSeconds: 0 };
    current.count += 1;
    current.sumSeconds += durationSeconds;
    current.maxSeconds = Math.max(current.maxSeconds, durationSeconds);
    this.namedDurations.set(name, current);
  }

  public setGauge(name: string, value: number): void {
    assertMetricName(name);
    if (!Number.isFinite(value)) throw new RangeError("Metric gauge must be finite");
    this.gauges.set(name, value);
  }

  public renderPrometheus(): string {
    const lines = [
      "# HELP mosp_http_requests_total HTTP requests by normalized route.",
      "# TYPE mosp_http_requests_total counter",
    ];
    for (const [key, value] of this.requests) {
      const [method = "unknown", route = "unknown", status = "unknown"] = key.split("|");
      lines.push(`mosp_http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${escapeLabel(status)}"} ${value}`);
    }
    lines.push("# HELP mosp_http_request_duration_seconds_sum HTTP request duration sum.");
    lines.push("# TYPE mosp_http_request_duration_seconds_sum counter");
    for (const [key, value] of this.durations) {
      const [method = "unknown", route = "unknown"] = key.split("|");
      lines.push(`mosp_http_request_duration_seconds_sum{method="${escapeLabel(method)}",route="${escapeLabel(route)}"} ${value.sumSeconds}`);
      lines.push(`mosp_http_request_duration_seconds_count{method="${escapeLabel(method)}",route="${escapeLabel(route)}"} ${value.count}`);
    }
    for (const [name, value] of this.counters) {
      lines.push(`# HELP ${name} Application counter.`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${value}`);
    }
    for (const [name, value] of this.namedDurations) {
      lines.push(`# HELP ${name}_sum Application duration sum in seconds.`);
      lines.push(`# TYPE ${name}_sum counter`);
      lines.push(`${name}_sum ${value.sumSeconds}`);
      lines.push(`# HELP ${name}_count Application duration observation count.`);
      lines.push(`# TYPE ${name}_count counter`);
      lines.push(`${name}_count ${value.count}`);
      lines.push(`# HELP ${name}_max Application maximum duration in seconds.`);
      lines.push(`# TYPE ${name}_max gauge`);
      lines.push(`${name}_max ${value.maxSeconds}`);
    }
    for (const [name, value] of this.gauges) {
      lines.push(`# HELP ${name} Application gauge.`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value}`);
    }
    lines.push("# HELP mosp_process_uptime_seconds Process uptime.");
    lines.push("# TYPE mosp_process_uptime_seconds gauge");
    lines.push(`mosp_process_uptime_seconds ${process.uptime()}`);
    return `${lines.join("\n")}\n`;
  }
}

function assertMetricName(name: string): void {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
    throw new Error("Invalid metric name");
  }
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export function metricsTokenMatches(request: Request, configuredToken: string): boolean {
  const authorization = request.header("authorization");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : request.header("x-metrics-token")?.trim();
  if (!provided || provided.length !== configuredToken.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(configuredToken));
}
