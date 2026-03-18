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

/** Allowed MIME types for KYC documents. */
const ALLOWED_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
];

/** Sanitize filename: keep alphanumeric, dash, underscore, dot. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "document";
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
  contentType?: string;
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
  const ext = params.filename.split(".").pop()?.toLowerCase() ?? "";
  const baseName = sanitizeFilename(params.filename.replace(/\.[^.]+$/, "") || "document");
  const path = `kyc/${params.merchantId}/${randomUUID()}-${baseName}.${ext || "bin"}`;

  const contentType = params.contentType ?? "application/octet-stream";
  if (contentType !== "application/octet-stream" && !ALLOWED_TYPES.includes(contentType)) {
    throw new Error(`Invalid contentType. Allowed: ${ALLOWED_TYPES.join(", ")}`);
  }

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
