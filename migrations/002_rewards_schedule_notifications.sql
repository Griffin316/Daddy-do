-- For databases created before rewards/scheduling/notifications existed.
-- Run once: npx wrangler d1 execute daddy-do --remote --file=migrations/002_rewards_schedule_notifications.sql
-- then:     npm run db:init:remote   (creates the new tables + seed rewards; safe to re-run)
ALTER TABLE tickets ADD COLUMN scheduled_for TEXT;
ALTER TABLE tickets ADD COLUMN scheduled_time TEXT;
