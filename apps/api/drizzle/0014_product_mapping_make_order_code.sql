ALTER TABLE `product_mappings` ADD `wdt_make_order_code` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `product_mappings` SET `wdt_make_order_code` = `wdt_spec_no` WHERE `wdt_make_order_code` = '';
