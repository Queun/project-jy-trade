ALTER TABLE `review_lines` ADD `planned_ship_qty` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `review_lines`
SET `planned_ship_qty` = CASE
  WHEN EXISTS (
    SELECT 1
    FROM `batches`
    WHERE `batches`.`id` = `review_lines`.`batch_id`
      AND `batches`.`source_type` = 'confirmed_order'
  ) THEN `suggested_ship_qty`
  ELSE `order_qty`
END;
