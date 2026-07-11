ALTER TABLE `batches` ADD `stock_snapshot_run_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `batches` ADD `stock_snapshot_at` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE `wdt_sync_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `trigger` text NOT NULL,
  `status` text NOT NULL,
  `stage` text NOT NULL,
  `goods_sync_run_id` text DEFAULT '' NOT NULL,
  `total_spec_count` integer DEFAULT 0 NOT NULL,
  `processed_spec_count` integer DEFAULT 0 NOT NULL,
  `total_batch_count` integer DEFAULT 0 NOT NULL,
  `completed_batch_count` integer DEFAULT 0 NOT NULL,
  `stock_row_count` integer DEFAULT 0 NOT NULL,
  `started_at` text NOT NULL,
  `finished_at` text DEFAULT '' NOT NULL,
  `last_progress_at` text NOT NULL,
  `error_code` text DEFAULT '' NOT NULL,
  `error_message` text DEFAULT '' NOT NULL,
  `error_detail` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `wdt_sync_runs_status_idx` ON `wdt_sync_runs` (`status`);
--> statement-breakpoint
CREATE INDEX `wdt_sync_runs_started_at_idx` ON `wdt_sync_runs` (`started_at`);
--> statement-breakpoint
CREATE TABLE `wdt_stock_snapshot_specs` (`sync_run_id` text NOT NULL, `spec_no` text NOT NULL, `synced_at` text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `wdt_stock_snapshot_specs_run_spec_unique` ON `wdt_stock_snapshot_specs` (`sync_run_id`,`spec_no`);
--> statement-breakpoint
CREATE INDEX `wdt_stock_snapshot_specs_spec_idx` ON `wdt_stock_snapshot_specs` (`spec_no`);
--> statement-breakpoint
CREATE TABLE `wdt_stock_snapshot_rows` (
  `id` text PRIMARY KEY NOT NULL,
  `sync_run_id` text NOT NULL,
  `spec_no` text NOT NULL,
  `warehouse_no` text DEFAULT '' NOT NULL,
  `warehouse_name` text DEFAULT '' NOT NULL,
  `available_send_stock` real DEFAULT 0 NOT NULL,
  `raw_json` text DEFAULT '{}' NOT NULL,
  `synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wdt_stock_snapshot_rows_identity_unique` ON `wdt_stock_snapshot_rows` (`sync_run_id`,`spec_no`,`warehouse_no`,`warehouse_name`);
--> statement-breakpoint
CREATE INDEX `wdt_stock_snapshot_rows_run_spec_idx` ON `wdt_stock_snapshot_rows` (`sync_run_id`,`spec_no`);
