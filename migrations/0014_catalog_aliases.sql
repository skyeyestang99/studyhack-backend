-- 0006: alternate catalog names used by client-side ranked search.
-- Arrays keep the read contract compact and allow canonical-schools imports to
-- attach several common names without another join.

ALTER TABLE schools ADD COLUMN IF NOT EXISTS short_name text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT '{}';
ALTER TABLE professors ADD COLUMN IF NOT EXISTS short_name text;
ALTER TABLE professors ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT '{}';

UPDATE schools
SET short_name = 'UC San Diego',
    aliases = ARRAY['UCSD', 'University of California San Diego']
WHERE id = '11111111-1111-1111-1111-111111111111'
  AND short_name IS NULL;
