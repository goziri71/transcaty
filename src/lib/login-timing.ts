/**
 * Login-timing helpers (P4 Auth Hardening).
 *
 * Two correctness goals:
 *
 * 1. **No user enumeration via timing.** Whether the email exists, has
 *    no password set, or is suspended, the login handler must always
 *    perform a bcrypt compare so the wall-clock cost is uniform.
 *
 * 2. **No user enumeration via error messages.** Every non-MFA failure
 *    returns the same opaque message; the actual reason goes to the
 *    audit log so ops can still triage.
 *
 * Use {@link verifyPasswordOrDummy} from auth handlers; it accepts a
 * possibly-null hash and either runs a real bcrypt compare or compares
 * against a precomputed dummy hash, then always returns false in the
 * latter case. Use {@link UNIFIED_LOGIN_FAILURE} for the user-facing
 * response message.
 */
import bcrypt from "bcrypt";

export const UNIFIED_LOGIN_FAILURE = "Invalid email or password";

/**
 * Bcrypt of the literal string "invalid-password-placeholder" computed
 * with the same cost we use everywhere else (10). Hard-coding avoids
 * the ~80ms cost on first import and keeps the module pure.
 *
 * Regenerate via:
 *   node -e "import('bcrypt').then(b=>b.hash('invalid-password-placeholder',10).then(console.log))"
 */
const DUMMY_HASH =
  "$2b$10$CwTycUXWue0Thq9StjUM0uJ8pZ8bqL3JmQkXU3MFT3uYqCMSvU7Iy";

/**
 * Run a bcrypt compare against the user's hash if present; otherwise
 * run the same compare against a fixed dummy hash so the timing of the
 * "user not found" path mirrors the "wrong password" path.
 *
 * Always returns false when `hash` is null / empty. Never throws on
 * malformed hashes — bcrypt would, so we wrap and report failure.
 */
export async function verifyPasswordOrDummy(
  password: string,
  hash: string | null | undefined
): Promise<boolean> {
  if (hash && hash.length > 0) {
    try {
      return await bcrypt.compare(password, hash);
    } catch {
      return false;
    }
  }
  // No hash: still run the bcrypt compare against the dummy so the
  // request takes ~constant time regardless of which branch we're on.
  try {
    await bcrypt.compare(password, DUMMY_HASH);
  } catch {
    /* swallow */
  }
  return false;
}
