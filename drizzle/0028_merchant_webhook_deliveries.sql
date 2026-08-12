-- Outbound merchant webhook delivery log (dashboard delivery log / replay / last error).
CREATE TABLE IF NOT EXISTS merchant_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  transaction_id uuid,
  payload text NOT NULL,
  target_url text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  http_status integer,
  response_body text,
  error text,
  attempt integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS merchant_webhook_deliveries_merchant_created_idx
  ON merchant_webhook_deliveries (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS merchant_webhook_deliveries_status_idx
  ON merchant_webhook_deliveries (status);
CREATE INDEX IF NOT EXISTS merchant_webhook_deliveries_tx_idx
  ON merchant_webhook_deliveries (transaction_id);
