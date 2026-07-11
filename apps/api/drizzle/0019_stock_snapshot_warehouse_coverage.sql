CREATE TABLE `wdt_stock_snapshot_warehouse_coverage` (
  `sync_run_id` text NOT NULL,
  `warehouse_type` text NOT NULL,
  `api_warehouse_no` text DEFAULT '' NOT NULL,
  `synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wdt_stock_snapshot_warehouse_coverage_unique`
ON `wdt_stock_snapshot_warehouse_coverage` (`sync_run_id`, `warehouse_type`);
--> statement-breakpoint
CREATE INDEX `wdt_stock_snapshot_warehouse_coverage_run_idx`
ON `wdt_stock_snapshot_warehouse_coverage` (`sync_run_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `wdt_stock_snapshot_warehouse_coverage` (`sync_run_id`, `warehouse_type`, `api_warehouse_no`, `synced_at`)
SELECT `id`, 'main', '', `finished_at` FROM `wdt_sync_runs` WHERE `status` = 'success';
--> statement-breakpoint
INSERT OR IGNORE INTO `wdt_stock_snapshot_warehouse_coverage` (`sync_run_id`, `warehouse_type`, `api_warehouse_no`, `synced_at`)
SELECT `id`, 'near_expiry', '', `finished_at` FROM `wdt_sync_runs` WHERE `status` = 'success';
--> statement-breakpoint
INSERT OR IGNORE INTO `wdt_stock_snapshot_warehouse_coverage` (`sync_run_id`, `warehouse_type`, `api_warehouse_no`, `synced_at`)
SELECT `id`, 'defect', '', `finished_at` FROM `wdt_sync_runs` WHERE `status` = 'success';
--> statement-breakpoint
INSERT OR IGNORE INTO `wdt_stock_snapshot_warehouse_coverage` (`sync_run_id`, `warehouse_type`, `api_warehouse_no`, `synced_at`)
SELECT `id`, 'other', '', `finished_at` FROM `wdt_sync_runs` WHERE `status` = 'success';
