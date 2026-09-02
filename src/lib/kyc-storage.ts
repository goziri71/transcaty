/**
 * KYC document storage – Supabase Storage.
 * Private bucket; access via signed upload URLs only.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.KYC_STORAGE_BUCKET ?? "kyc-documents";

function getClient(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for KYC document uploads"
    );
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

/** Allowed MIME types for KYC documents, mapped to the extensions they may pair with. */
const ALLOWED_TYPES: Record<string, string[]> = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/jpg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
};

/** Exposed for the request-schema layer so invalid content types 400 before reaching this module. */
export const ALLOWED_KYC_CONTENT_TYPES = Object.keys(ALLOWED_TYPES) as [string, ...string[]];

/** Sanitize filename: keep alphanumeric, dash, underscore, dot. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "document";
}

/** Sanitize extension: lowercase alphanumeric only, capped to a sane length. */
function sanitizeExtension(ext: string): string {
  return ext.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10).toLowerCase();
}

/**
 * Create a signed upload URL for uploading a KYC document to Supabase Storage.
 * Returns uploadToken and path for frontend to call uploadToSignedUrl(path, token, file).
 * fileReference = path (stored in DB for retrieval).
 */
export async function createKycUploadUrl(params: {
  merchantId: string;
  documentType: string;
  filename: string;
  contentType: string;
  merchantPersonId?: string;
}): Promise<{
  uploadUrl: string;
  uploadToken: string;
  path: string;
  bucket: string;
  fileReference: string;
  expiresIn: number;
}> {
  const client = getClient();

  const contentType = params.contentType?.trim().toLowerCase() ?? "";
  const allowedExtensions = ALLOWED_TYPES[contentType];
  if (!allowedExtensions) {
    throw new Error(`Invalid contentType. Allowed: ${Object.keys(ALLOWED_TYPES).join(", ")}`);
  }

  const rawExt = sanitizeExtension(params.filename.split(".").pop() ?? "");
  if (!allowedExtensions.includes(rawExt)) {
    throw new Error(
      `File extension does not match contentType. Expected one of: ${allowedExtensions.join(", ")}`
    );
  }

  const baseName = sanitizeFilename(params.filename.replace(/\.[^.]+$/, "") || "document");
  const path = `kyc/${params.merchantId}/${randomUUID()}-${baseName}.${rawExt}`;

  const { data, error } = await client.storage
    .from(BUCKET)
    .createSignedUploadUrl(path, { upsert: false });

  if (error) {
    throw new Error(`Supabase createSignedUploadUrl failed: ${error.message}`);
  }
  if (!data?.path || !data?.token) {
    throw new Error("Supabase createSignedUploadUrl returned invalid response");
  }

  const expiresIn = 7200; // 2 hours (Supabase default)

  return {
    uploadUrl: SUPABASE_URL!, // Frontend uses this + storage API
    uploadToken: data.token,
    path: data.path,
    bucket: BUCKET,
    fileReference: data.path,
    expiresIn,
  };
}

/** Signed read URL for provider KYC review (short-lived). */
export async function createKycDownloadUrl(
  fileReference: string,
  expiresIn = 3600
): Promise<{ downloadUrl: string; expiresIn: number }> {
  const client = getClient();
  const { data, error } = await client.storage.from(BUCKET).createSignedUrl(fileReference, expiresIn);
  if (error) {
    throw new Error(`Supabase createSignedUrl failed: ${error.message}`);
  }
  if (!data?.signedUrl) {
    throw new Error("Supabase createSignedUrl returned invalid response");
  }
  return { downloadUrl: data.signedUrl, expiresIn };
}
