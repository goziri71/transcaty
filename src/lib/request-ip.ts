import type { FastifyRequest } from "fastify";

export function getClientIp(request: FastifyRequest): string {
  const xff = request.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  if (Array.isArray(xff) && xff[0]) {
    return String(xff[0]).trim();
  }
  return request.ip || "unknown";
}
