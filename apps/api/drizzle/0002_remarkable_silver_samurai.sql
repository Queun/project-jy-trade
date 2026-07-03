CREATE TABLE `product_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`external_barcode` text DEFAULT '' NOT NULL,
	`external_goods_name` text DEFAULT '' NOT NULL,
	`external_goods_code` text DEFAULT '' NOT NULL,
	`wdt_goods_no` text DEFAULT '' NOT NULL,
	`wdt_goods_name` text DEFAULT '' NOT NULL,
	`wdt_spec_no` text NOT NULL,
	`wdt_spec_name` text DEFAULT '' NOT NULL,
	`wdt_barcode` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`source_batch_id` text DEFAULT '' NOT NULL,
	`confirmed_by_user_id` text,
	`confirmed_at` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `product_mappings_external_barcode_idx` ON `product_mappings` (`external_barcode`);--> statement-breakpoint
CREATE INDEX `product_mappings_external_goods_code_idx` ON `product_mappings` (`external_goods_code`);--> statement-breakpoint
CREATE INDEX `product_mappings_wdt_spec_no_idx` ON `product_mappings` (`wdt_spec_no`);--> statement-breakpoint
CREATE TABLE `product_match_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`review_line_id` text DEFAULT '' NOT NULL,
	`external_barcode` text DEFAULT '' NOT NULL,
	`external_goods_name` text DEFAULT '' NOT NULL,
	`external_goods_code` text DEFAULT '' NOT NULL,
	`wdt_spec_no` text DEFAULT '' NOT NULL,
	`wdt_goods_no` text DEFAULT '' NOT NULL,
	`wdt_goods_name` text DEFAULT '' NOT NULL,
	`wdt_spec_name` text DEFAULT '' NOT NULL,
	`wdt_barcode` text DEFAULT '' NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`basis` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'goods' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `product_match_candidates_batch_id_idx` ON `product_match_candidates` (`batch_id`);--> statement-breakpoint
CREATE INDEX `product_match_candidates_review_line_id_idx` ON `product_match_candidates` (`review_line_id`);--> statement-breakpoint
CREATE TABLE `wdt_goods_specs` (
	`id` text PRIMARY KEY NOT NULL,
	`goods_no` text DEFAULT '' NOT NULL,
	`goods_name` text DEFAULT '' NOT NULL,
	`spec_no` text NOT NULL,
	`spec_name` text DEFAULT '' NOT NULL,
	`spec_code` text DEFAULT '' NOT NULL,
	`barcode` text DEFAULT '' NOT NULL,
	`barcodes_json` text DEFAULT '[]' NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`modified` text DEFAULT '' NOT NULL,
	`raw_json` text DEFAULT '{}' NOT NULL,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wdt_goods_specs_spec_no_unique` ON `wdt_goods_specs` (`spec_no`);--> statement-breakpoint
CREATE INDEX `wdt_goods_specs_barcode_idx` ON `wdt_goods_specs` (`barcode`);--> statement-breakpoint
CREATE INDEX `wdt_goods_specs_goods_no_idx` ON `wdt_goods_specs` (`goods_no`);--> statement-breakpoint
CREATE INDEX `wdt_goods_specs_modified_idx` ON `wdt_goods_specs` (`modified`);--> statement-breakpoint
CREATE TABLE `wdt_goods_sync_runs` (
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
CREATE INDEX `wdt_goods_sync_runs_started_at_idx` ON `wdt_goods_sync_runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `wdt_goods_sync_runs_status_idx` ON `wdt_goods_sync_runs` (`status`);
