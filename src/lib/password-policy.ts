/**
 * Shared password strength checks for portal + provider signup/reset.
 * Length floor is above the previous min(8); requires letter + digit.
 */
import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** Small denylist of common weak passwords (lowercase compare). */
const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "1234567890",
  "0123456789",
  "qwertyuiop",
  "abcdefghij",
  "letmein123",
  "welcome123",
  "admin12345",
  "changeme12",
  "transacty1",
  "transacty12",
]);

export type PasswordPolicyResult = { ok: true } | { ok: false; message: string };

export function validatePasswordStrength(password: string): PasswordPolicyResult {
  if (typeof password !== "string") {
    return { ok: false, message: "Password is required" };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
    };
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return {
      ok: false,
      message: "Password must include at least one letter and one number",
    };
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, message: "Password is too common; choose a stronger one" };
  }
  return { ok: true };
}

/** Human-readable requirements for API/docs/frontend copy. */
export const PASSWORD_REQUIREMENTS_COPY =
  `At least ${PASSWORD_MIN_LENGTH} characters, including a letter and a number. Avoid common passwords.`;

/** Zod field for signup / reset / admin-set passwords (not login). */
export const strongPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH)
  .superRefine((val, ctx) => {
    const result = validatePasswordStrength(val);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message });
    }
  });
