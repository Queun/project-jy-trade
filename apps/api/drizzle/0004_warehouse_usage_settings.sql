CREATE TABLE IF NOT EXISTS `warehouse_usage_settings` (
  `id` text PRIMARY KEY NOT NULL,
  `include_main_warehouse` integer DEFAULT 1 NOT NULL,
  `include_near_expiry_warehouse` integer DEFAULT 1 NOT NULL,
  `include_defect_warehouse` integer DEFAULT 0 NOT NULL,
  `include_other_warehouses` integer DEFAULT 0 NOT NULL,
  `updated_by_user_id` text,
  `updated_by_username` text,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `warehouse_usage_settings` (
  `id`,
  `include_main_warehouse`,
  `include_near_expiry_warehouse`,
  `include_defect_warehouse`,
  `include_other_warehouses`,
  `updated_by_user_id`,
  `updated_by_username`,
  `updated_at`
) VALUES ('default', 1, 1, 0, 0, NULL, NULL, '2026-07-06T00:00:00.000Z');
