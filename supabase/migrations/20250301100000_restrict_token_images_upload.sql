-- Restrict uploads to token-images bucket: only service_role (via Edge Function) can upload.
-- Drop policies that allow anon/authenticated to INSERT into token-images.
-- Service_role bypasses RLS and can always upload.

-- Drop token-images specific upload policies (names may vary; add others if needed)
DROP POLICY IF EXISTS "token-images anon upload" ON storage.objects;
DROP POLICY IF EXISTS "token-images authenticated upload" ON storage.objects;
DROP POLICY IF EXISTS "token-images public upload" ON storage.objects;

-- Ensure public SELECT (read) for token-images so images can be displayed
-- Only create if it doesn't exist - adjust policy name if your project uses different naming
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' AND tablename = 'objects' 
    AND policyname = 'token-images public read'
  ) THEN
    CREATE POLICY "token-images public read"
    ON storage.objects FOR SELECT
    TO public
    USING (bucket_id = 'token-images');
  END IF;
END $$;
