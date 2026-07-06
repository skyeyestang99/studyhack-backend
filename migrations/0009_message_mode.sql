-- 0009: persist the grounding mode of an assistant answer so the honest
-- provenance badge (grounded / partial / general) shows on historical messages.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mode text;
