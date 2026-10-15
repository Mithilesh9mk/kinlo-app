-- Kinlo · 0037 · a private bucket for personal-expense screenshots
--
-- Companion to 0036_personal_transactions.sql. Separate file, deliberately —
-- CREATE POLICY ... ON storage.objects needs different privileges than a
-- plain public.* DDL statement, and if the migration role doesn't have them
-- this file fails cleanly on its own without leaving 0036 half-applied. If
-- it does fail, 0036 has already landed and only this file needs a
-- dashboard-side redo.
--
-- This is the first Storage bucket in this project. There is no existing
-- upload flow to imitate — the onboarding "avatar upload" is not a real one,
-- it only swaps between four hardcoded remote URLs.
--
-- PATH CONVENTION: {user_id}/{personal_transaction_id}.jpg
--
-- The transaction id is minted client-side before the image is uploaded, so
-- the storage path is derived from it up front — no reverse lookup from
-- object name to owning row is ever needed. The first path segment is the
-- owner, which is exactly what the policies below key on via
-- storage.foldername(name).
--
-- PUBLIC = FALSE, ALWAYS SIGNED URLS
--
-- A public bucket would make every user's payment screenshots readable by
-- anyone who could guess two UUIDs. The app must only ever render these
-- images through short-lived signed URLs (createSignedUrl), never a public
-- object URL.
--
-- RETENTION
--
-- Kept indefinitely, by product decision — the image is the audit trail
-- behind a machine-parsed number, and deleting it would leave that number
-- unverifiable. No purge job exists or is planned for v1; stated here so
-- it isn't assumed to exist.
--
-- KNOWN GAP, FLAGGED NOT FIXED
--
-- Voiding a personal_transactions row does not delete its object here, and
-- the "Delete Account" panel in app/(tabs)/profile.tsx has no real backend
-- today. When it gets one, it will need to sweep receipts/{user_id}/ as
-- part of account deletion. Not built in this migration.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'receipts',
  'receipts',
  false,
  10485760, -- 10 MB; a server-side backstop, the client checks first
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY receipts_select ON storage.objects FOR SELECT
  USING (bucket_id = 'receipts' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY receipts_insert ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'receipts' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY receipts_update ON storage.objects FOR UPDATE
  USING (bucket_id = 'receipts' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'receipts' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY receipts_delete ON storage.objects FOR DELETE
  USING (bucket_id = 'receipts' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT id, public, file_size_limit, allowed_mime_types
--   FROM storage.buckets WHERE id = 'receipts';
--   -> one row, public = false, file_size_limit = 10485760
--
--   SELECT policyname FROM pg_policies
--   WHERE schemaname = 'storage' AND tablename = 'objects'
--     AND policyname LIKE 'receipts_%';
--   -> exactly 4: receipts_select, receipts_insert, receipts_update, receipts_delete
--
-- Cross-user isolation, exercised from the app (auth.uid() is NULL in the SQL
-- editor, same caveat as 0036):
--   - As user A, upload to '<A_user_id>/x.jpg' -> must succeed.
--   - As user A, attempt an upload to '<B_user_id>/x.jpg' -> must be denied.
--   - As user B, attempt to download '<A_user_id>/x.jpg' -> must be denied.
