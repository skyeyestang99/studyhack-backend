-- 0018: let a user (or course) be deleted cleanly.
-- enrollments' FKs were created without ON DELETE (default RESTRICT), so deleting
-- a beta/test user failed on the enrollments FK until rows were removed by hand.
-- conversations / flashcards / syllabus_events already cascade on user_id; this
-- brings enrollments in line. (materials still needs its own fix — it uses a
-- text owner_user_id with no FK; see docs/db-manageability.md.)

ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_user_id_fkey;
ALTER TABLE enrollments
  ADD CONSTRAINT enrollments_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_course_id_fkey;
ALTER TABLE enrollments
  ADD CONSTRAINT enrollments_course_id_fkey
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE;
