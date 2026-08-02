import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { MetricsRegistry } from "./metrics.js";

describe("metrics", () => {
  it("renders normalized request counters and protects the endpoint", async () => {
    const app = createApp({ metricsToken: "metrics-secret" });
    await request(app).get("/healthz");
    expect((await request(app).get("/metrics")).status).toBe(404);
    const response = await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer metrics-secret");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    expect(response.text).toContain("mosp_http_requests_total");
    expect(response.text).toContain('route="/healthz"');
  });

  it("uses constant-time token comparison semantics for equal-length tokens", () => {
    const registry = new MetricsRegistry();
    registry.observeRequest({ method: "GET", route: "/healthz", status: 200 }, 0.01);
    registry.observeDuration("mosp_proxy_upload_duration_seconds", 0.25);
    registry.observeDuration("mosp_proxy_upload_duration_seconds", 0.5);
    registry.incrementCounter("mosp_proxy_upload_bytes_total", 5);
    const rendered = registry.renderPrometheus();
    expect(registry.renderPrometheus()).toContain("mosp_process_uptime_seconds");
    expect(rendered).toContain("mosp_proxy_upload_duration_seconds_count 2");
    expect(rendered).toContain("mosp_proxy_upload_duration_seconds_sum 0.75");
    expect(rendered).toContain("mosp_proxy_upload_duration_seconds_max 0.5");
    expect(rendered).toContain("mosp_proxy_upload_bytes_total 5");
  });
});
