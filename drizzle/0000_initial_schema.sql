CREATE TABLE `click_daily` (
	`code` text NOT NULL,
	`day` text NOT NULL,
	`clicks` integer NOT NULL,
	PRIMARY KEY(`code`, `day`),
	FOREIGN KEY (`code`) REFERENCES `links`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "clicks_nonnegative" CHECK("click_daily"."clicks" >= 0)
);
--> statement-breakpoint
CREATE TABLE `links` (
	`code` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`target_url` text NOT NULL,
	`request_hash` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	CONSTRAINT "links_target_length" CHECK(length("links"."target_url") <= 2048),
	CONSTRAINT "links_expiry_check" CHECK("links"."expires_at" IS NULL OR "links"."expires_at" > "links"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_idempotency_unique` ON `links` (`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `links_owner_page_idx` ON `links` (`owner_id`,`created_at`,`code`);--> statement-breakpoint
CREATE INDEX `links_state_idx` ON `links` (`code`,`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `rate_buckets` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_buckets_expiry_idx` ON `rate_buckets` (`expires_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`expires_at`);