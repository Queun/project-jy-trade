CREATE TABLE IF NOT EXISTS `store_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`store_no` text DEFAULT '' NOT NULL,
	`store_name` text NOT NULL,
	`normalized_store_name` text DEFAULT '' NOT NULL,
	`receiver` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`address` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`updated_by_user_id` text,
	`updated_by_username` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `store_addresses_store_no_idx` ON `store_addresses` (`store_no`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `store_addresses_normalized_store_name_idx` ON `store_addresses` (`normalized_store_name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `store_addresses_updated_at_idx` ON `store_addresses` (`updated_at`);
