/**
 * Prometheus metrics (APM-style): HTTP latency histogram, request counter, Node defaults.
 * Scrape GET /metrics (optionally protected by METRICS_TOKEN).
 */
import { Registry, Counter, Histogram, collectDefaultMetrics } from "prom-client";
import type { FastifyReply, FastifyRequest } from "fastify";

const register = new Registry();

collectDefaultMetrics({
  register,
  prefix: "transacty_",
});

export const httpRequestDurationSeconds = new Histogram({
  name: "transacty_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestsTotal = new Counter({
  name: "transacty_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [register],
});

export function getMetricsRegistry(): Registry {
  return register;
}

function routeLabel(request: FastifyRequest): string {
  const ro = request.routeOptions as { url?: string } | undefined;
  const ctx = ro?.url;
  if (typeof ctx === "string" && ctx.length > 0) return ctx;
  const p = request.url.split("?")[0];
  return p || "unknown";
}

export function recordHttpRequest(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  durationSeconds: number;
}): void {
  const { request, reply, durationSeconds } = params;
  const method = request.method;
  const route = routeLabel(request);
  const status = String(reply.statusCode);
  const labels = { method, route, status_code: status };
  httpRequestDurationSeconds.observe(labels, durationSeconds);
  httpRequestsTotal.inc(labels);
}

export async function renderMetrics(): Promise<string> {
  return register.metrics();
}

export function getMetricsContentType(): string {
  return register.contentType;
}
