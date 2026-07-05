-- 0007: align conversations ids to uuid + real FKs (root cause of the T3 500).
-- conversations.user_id / course_id were TEXT with no FK, which let an invalid
-- courseId poison a user's whole list. Convert to uuid + FK.

-- 1. Remove legacy dev rows with non-uuid ids (mock artifacts, e.g. 'mock-user-id')
--    so the type change is safe. (Dev-only throwaway chat data.)
DELETE FROM conversations
 WHERE user_id   !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR course_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- 2. Remove orphans that would violate the new foreign keys.
DELETE FROM conversations WHERE user_id::uuid   NOT IN (SELECT id FROM users);
DELETE FROM conversations WHERE course_id::uuid NOT IN (SELECT id FROM courses);

-- 3. Convert the columns to uuid.
ALTER TABLE conversations ALTER COLUMN user_id   TYPE uuid USING user_id::uuid;
ALTER TABLE conversations ALTER COLUMN course_id TYPE uuid USING course_id::uuid;

-- 4. Add the foreign keys.
ALTER TABLE conversations
  ADD CONSTRAINT fk_conversations_user   FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
  ADD CONSTRAINT fk_conversations_course FOREIGN KEY (course_id) REFERENCES courses(id);
