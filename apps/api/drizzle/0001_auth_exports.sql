ALTER TABLE `sessions` ADD `last_used_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `exports` ADD `file_path` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `exports` ADD `error_message` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `exports` ADD `created_by_user_id` text;--> statement-breakpoint
ALTER TABLE `exports` ADD `created_by_username` text;
