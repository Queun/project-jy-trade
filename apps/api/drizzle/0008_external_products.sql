CREATE TABLE IF NOT EXISTS `external_products` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`external_barcode` text DEFAULT '' NOT NULL,
	`external_goods_code` text DEFAULT '' NOT NULL,
	`external_goods_name` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`source_file_name` text DEFAULT '' NOT NULL,
	`source_sheet` text DEFAULT '' NOT NULL,
	`source_row` integer DEFAULT 0 NOT NULL,
	`imported_at` text DEFAULT '' NOT NULL,
	`raw_json` text DEFAULT '{}' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`updated_by_user_id` text,
	`updated_by_username` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `external_products_type_idx` ON `external_products` (`type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `external_products_external_barcode_idx` ON `external_products` (`external_barcode`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `external_products_external_goods_code_idx` ON `external_products` (`external_goods_code`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `external_products_updated_at_idx` ON `external_products` (`updated_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `external_product_components` (
	`id` text PRIMARY KEY NOT NULL,
	`external_product_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	`role` text DEFAULT 'primary' NOT NULL,
	`component_barcode` text DEFAULT '' NOT NULL,
	`component_goods_code` text DEFAULT '' NOT NULL,
	`component_name` text DEFAULT '' NOT NULL,
	`component_spec` text DEFAULT '' NOT NULL,
	`quantity_multiplier` real DEFAULT 1 NOT NULL,
	`wdt_spec_no` text DEFAULT '' NOT NULL,
	`wdt_goods_no` text DEFAULT '' NOT NULL,
	`wdt_goods_name` text DEFAULT '' NOT NULL,
	`wdt_spec_name` text DEFAULT '' NOT NULL,
	`wdt_barcode` text DEFAULT '' NOT NULL,
	`match_status` text NOT NULL,
	`match_message` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`source_sheet` text DEFAULT '' NOT NULL,
	`source_row` integer DEFAULT 0 NOT NULL,
	`raw_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `external_product_components_product_id_idx` ON `external_product_components` (`external_product_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `external_product_components_component_barcode_idx` ON `external_product_components` (`component_barcode`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `external_product_components_wdt_spec_no_idx` ON `external_product_components` (`wdt_spec_no`);
