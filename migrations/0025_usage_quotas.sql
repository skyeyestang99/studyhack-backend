-- 0025: tier-aware usage quotas (Iteration A).
--
-- The existing @fastify/rate-limit of 120 req/min is a loop guard, not a usage
-- ceiling: it stops a runaway client and does nothing about a user who steadily
-- consumes an expensive operation all day. Quick Help in particular is an
-- authenticated, zero-setup path to a paid model.
--
-- Per docs/paid-model-design.md these quotas are ABUSE and BLAST-RADIUS control, not
-- margin control — a chat message costs ~$0.0005, so no human can spend meaningfully;
-- only a script or a pathological upload can.
--
-- Limits live in a TABLE rather than in code so pricing can change without a deploy.
-- That is the property worth testing.

CREATE TABLE IF NOT EXISTS plan_limits (
  tier       text    NOT NULL,
  kind       text    NOT NULL,
  daily_limit integer NOT NULL CHECK (daily_limit >= 0),
  PRIMARY KEY (tier, kind),
  CHECK (tier IN ('FREE', 'STUDENT', 'TERM', 'BETA')),
  -- 'ocr_page' is metered in PAGES, not requests: a single upload can be 500 pages,
  -- and because ingestion is serialized it blocks every other student behind it.
  CHECK (kind IN (
    'quick_help',
    'course_chat',
    'study_guide',
    'exam_insights',
    'upload',
    'ocr_page',
    'escalation'
  ))
);

-- Seeded generously for TEXT operations on purpose: the free tier has to be able to
-- DEMONSTRATE the product, and a cap below a real homework session makes it useless as
-- a funnel. At $0.0005 per message no human can spend meaningfully; only a script can.
--
-- OCR is the exception, and it is seeded from a MEASUREMENT rather than a guess.
-- Measured 2026-08-13 against a real page at scale 2: 25,518 input + 111 output tokens
-- per page = $0.0039/page on gpt-4o-mini. That is ~7x a chat message PER PAGE, so a
-- 60-page document costs ~$0.23 — about 430 chat messages.
--
-- The first draft of this file set ocr_page to 300/day for STUDENT, having read
-- "300/month" from the design doc. At the measured rate that is $35/month of worst-case
-- spend against $9 of revenue. Corrected below so worst-case monthly OCR stays under
-- revenue for every paid tier:
--
--   FREE     15/day  -> $1.75/mo worst case (a free user can still cost us something,
--                       but bounded, and they are the funnel)
--   STUDENT  60/day  -> $7.01/mo worst case, under $9 revenue, with enough headroom
--                       for a student bulk-uploading a term of scans while onboarding
--   BETA    100/day  -> $11.68/mo worst case; we are not charging, the invite list is
--                       small, and a real limit means the enforcement path is actually
--                       exercised
--
-- Follow-up optimisation worth more than tightening limits further: the 25.5k input
-- tokens come from rendering at scale 2. Rendering smaller would cut cost close to
-- proportionally, and OCR quality on printed exam text likely survives it.
--
-- Text limits remain starting points — measurement 2 in the design doc (messages per
-- session) should set the grounded cap near p75 of a real session.
INSERT INTO plan_limits (tier, kind, daily_limit) VALUES
  ('FREE',    'quick_help',    10),
  ('FREE',    'course_chat',   10),
  ('FREE',    'study_guide',    0),
  ('FREE',    'exam_insights', 20),
  ('FREE',    'upload',         5),
  ('FREE',    'ocr_page',      15),
  ('FREE',    'escalation',     0),

  ('STUDENT', 'quick_help',   200),
  ('STUDENT', 'course_chat',  200),
  ('STUDENT', 'study_guide',   10),
  ('STUDENT', 'exam_insights',200),
  ('STUDENT', 'upload',        50),
  ('STUDENT', 'ocr_page',      60),
  ('STUDENT', 'escalation',    10),

  ('TERM',    'quick_help',   200),
  ('TERM',    'course_chat',  200),
  ('TERM',    'study_guide',   10),
  ('TERM',    'exam_insights',200),
  ('TERM',    'upload',        50),
  ('TERM',    'ocr_page',      60),
  ('TERM',    'escalation',    10),

  -- Every beta invitee is BETA. Deliberately high but NOT unlimited: the point of
  -- shipping quotas before launch is that the enforcement path is exercised in
  -- anger, and an unlimited tier would never exercise it.
  ('BETA',    'quick_help',   500),
  ('BETA',    'course_chat',  500),
  ('BETA',    'study_guide',   30),
  ('BETA',    'exam_insights',500),
  ('BETA',    'upload',       200),
  ('BETA',    'ocr_page',     100),
  ('BETA',    'escalation',    30)
ON CONFLICT (tier, kind) DO NOTHING;

-- Tier lives on the user. subscription_* columns are deliberately NOT added here:
-- Stripe is deferred past launch, and adding columns nothing writes to invites
-- someone to assume they are meaningful.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'BETA'
  CHECK (tier IN ('FREE', 'STUDENT', 'TERM', 'BETA'));

-- Usage is counted per user, per UTC day, per kind.
--
-- `amount` rather than a row per event: ocr_page consumes many units in one action,
-- and an events table would need aggregating on every check — on the hot path, before
-- a response has started streaming.
CREATE TABLE IF NOT EXISTS user_daily_usage (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     date NOT NULL,
  kind    text NOT NULL,
  amount  integer NOT NULL DEFAULT 0 CHECK (amount >= 0),
  PRIMARY KEY (user_id, day, kind)
);

-- Reporting/cleanup by day.
CREATE INDEX IF NOT EXISTS idx_user_daily_usage_day ON user_daily_usage (day);
