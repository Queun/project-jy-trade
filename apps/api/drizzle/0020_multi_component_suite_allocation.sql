ALTER TABLE `batches` ADD `allocation_priority` text DEFAULT 'suite_first' NOT NULL;
--> statement-breakpoint
ALTER TABLE `review_lines` ADD `product_type` text DEFAULT 'goods' NOT NULL;
--> statement-breakpoint
ALTER TABLE `review_lines` ADD `component_stock_json` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `warehouse_usage_settings` ADD `shared_component_priority` text DEFAULT 'suite_first' NOT NULL;
