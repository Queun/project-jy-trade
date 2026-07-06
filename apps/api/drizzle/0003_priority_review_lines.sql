ALTER TABLE `review_lines` ADD `priority` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `review_lines` ADD `priority_reason` text DEFAULT '' NOT NULL;
