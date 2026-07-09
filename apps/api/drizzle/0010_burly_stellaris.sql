CREATE TABLE `wdt_suite_components` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_no` text NOT NULL,
	`sort_order` integer NOT NULL,
	`spec_no` text DEFAULT '' NOT NULL,
	`goods_no` text DEFAULT '' NOT NULL,
	`goods_name` text DEFAULT '' NOT NULL,
	`spec_name` text DEFAULT '' NOT NULL,
	`spec_code` text DEFAULT '' NOT NULL,
	`barcode` text DEFAULT '' NOT NULL,
	`quantity` real DEFAULT 1 NOT NULL,
	`ratio` real DEFAULT 1 NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`raw_json` text DEFAULT '{}' NOT NULL,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `wdt_suite_components_suite_no_idx` ON `wdt_suite_components` (`suite_no`);--> statement-breakpoint
CREATE INDEX `wdt_suite_components_spec_no_idx` ON `wdt_suite_components` (`spec_no`);--> statement-breakpoint
CREATE INDEX `wdt_suite_components_barcode_idx` ON `wdt_suite_components` (`barcode`);--> statement-breakpoint
CREATE TABLE `wdt_suite_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text DEFAULT '' NOT NULL,
	`range_start` text NOT NULL,
	`range_end` text NOT NULL,
	`window_count` integer DEFAULT 0 NOT NULL,
	`page_count` integer DEFAULT 0 NOT NULL,
	`fetched_count` integer DEFAULT 0 NOT NULL,
	`upserted_count` integer DEFAULT 0 NOT NULL,
	`error_message` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `wdt_suite_sync_runs_started_at_idx` ON `wdt_suite_sync_runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `wdt_suite_sync_runs_status_idx` ON `wdt_suite_sync_runs` (`status`);--> statement-breakpoint
CREATE TABLE `wdt_suites` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_no` text NOT NULL,
	`suite_name` text DEFAULT '' NOT NULL,
	`barcode` text DEFAULT '' NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`modified` text DEFAULT '' NOT NULL,
	`raw_json` text DEFAULT '{}' NOT NULL,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wdt_suites_suite_no_unique` ON `wdt_suites` (`suite_no`);--> statement-breakpoint
CREATE INDEX `wdt_suites_barcode_idx` ON `wdt_suites` (`barcode`);--> statement-breakpoint
CREATE INDEX `wdt_suites_modified_idx` ON `wdt_suites` (`modified`);