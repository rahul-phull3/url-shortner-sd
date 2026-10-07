import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const sessions = sqliteTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    ownerId: text("owner_id").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("sessions_expiry_idx").on(table.expiresAt)],
);
export const links = sqliteTable(
  "links",
  {
    code: text("code").primaryKey(),
    ownerId: text("owner_id").notNull(),
    targetUrl: text("target_url").notNull(),
    requestHash: text("request_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("links_idempotency_unique").on(
      table.ownerId,
      table.idempotencyKey,
    ),
    index("links_owner_page_idx").on(
      table.ownerId,
      table.createdAt,
      table.code,
    ),
    index("links_state_idx").on(table.code, table.expiresAt, table.revokedAt),
    check("links_target_length", sql`length(${table.targetUrl}) <= 2048`),
    check(
      "links_expiry_check",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);
export const clickDaily = sqliteTable(
  "click_daily",
  {
    code: text("code")
      .notNull()
      .references(() => links.code),
    day: text("day").notNull(),
    clicks: integer("clicks").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.code, table.day] }),
    check("clicks_nonnegative", sql`${table.clicks} >= 0`),
  ],
);
export const rateBuckets = sqliteTable(
  "rate_buckets",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("rate_buckets_expiry_idx").on(table.expiresAt)],
);
