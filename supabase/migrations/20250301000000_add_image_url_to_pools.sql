-- Add image_url column to pools table
ALTER TABLE pools ADD COLUMN IF NOT EXISTS image_url text;

-- Note: Create Storage bucket 'token-images' in Supabase Dashboard (Storage > New bucket)
-- with public access for token image uploads.
