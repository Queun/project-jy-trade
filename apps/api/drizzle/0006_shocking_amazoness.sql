ALTER TABLE `store_addresses` ADD `source_sheet` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `store_addresses` ADD `source_row` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `store_addresses` ADD `imported_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `store_addresses` ADD `raw_json` text DEFAULT '{}' NOT NULL;
