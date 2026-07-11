ALTER TABLE `review_lines` ADD `suggested_warehouse_no` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `review_lines` ADD `suggested_warehouse_name` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `review_decisions` ADD `fulfillment_warehouse_no` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `review_decisions` ADD `fulfillment_warehouse_name` text DEFAULT '' NOT NULL;
