-- Rename platform merchant display name to Transacty branding
UPDATE "merchants"
SET "name" = 'Transacty Platform', "updated_at" = now()
WHERE "id" = '00000000-0000-0000-0000-000000000001';
