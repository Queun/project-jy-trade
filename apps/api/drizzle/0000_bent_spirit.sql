CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_entity_idx` ON `audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_created_at_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`file_path` text NOT NULL,
	`file_name` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`order_line_count` integer DEFAULT 0 NOT NULL,
	`unique_barcode_count` integer DEFAULT 0 NOT NULL,
	`matched_barcode_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `batches_created_at_idx` ON `batches` (`created_at`);--> statement-breakpoint
CREATE TABLE `exports` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`file_name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `exports_batch_id_idx` ON `exports` (`batch_id`);--> statement-breakpoint
CREATE TABLE `review_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`review_line_id` text NOT NULL,
	`reviewer_id` text,
	`decision` text NOT NULL,
	`approved_ship_qty` real NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `review_decisions_batch_id_idx` ON `review_decisions` (`batch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_decisions_review_line_id_unique` ON `review_decisions` (`review_line_id`);--> statement-breakpoint
CREATE TABLE `review_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	`order_notice_no` text NOT NULL,
	`excel_row` integer NOT NULL,
	`store_no` text NOT NULL,
	`store_name` text NOT NULL,
	`upload_time` text NOT NULL,
	`external_barcode` text NOT NULL,
	`external_goods_name` text NOT NULL,
	`goods_name` text DEFAULT '' NOT NULL,
	`spec_name` text DEFAULT '' NOT NULL,
	`wdt_spec_no` text DEFAULT '' NOT NULL,
	`match_status` text NOT NULL,
	`match_message` text DEFAULT '' NOT NULL,
	`order_qty` real NOT NULL,
	`main_available_before` real DEFAULT 0 NOT NULL,
	`near_expiry_available_before` real DEFAULT 0 NOT NULL,
	`suggested_ship_qty` real NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `review_lines_batch_id_idx` ON `review_lines` (`batch_id`);--> statement-breakpoint
CREATE INDEX `review_lines_batch_sort_idx` ON `review_lines` (`batch_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);