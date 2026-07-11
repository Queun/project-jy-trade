CREATE TABLE `wdt_sync_settings` (
  `id` text PRIMARY KEY NOT NULL,
  `interval_hours` integer DEFAULT 1 NOT NULL,
  `updated_by_user_id` text,
  `updated_by_username` text,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `wdt_sync_settings` (`id`, `interval_hours`, `updated_at`)
VALUES ('default', 1, CURRENT_TIMESTAMP);
