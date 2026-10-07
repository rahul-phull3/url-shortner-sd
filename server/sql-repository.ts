import type { Cursor, InsertResult, Link, LinkState } from "./domain.ts";
import type { Repository, Session } from "./ports.ts";

export type Row = Record<string, unknown>;
export type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;
const linkFromRow = (r: Row): Link => ({
  code: String(r.code),
  ownerId: String(r.owner_id),
  targetUrl: String(r.target_url),
  requestHash: String(r.request_hash),
  idempotencyKey: String(r.idempotency_key),
  createdAt: Number(r.created_at),
  expiresAt: r.expires_at === null ? null : Number(r.expires_at),
  revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
});

export class SqlRepository implements Repository {
  readonly query: Query;
  constructor(query: Query) {
    this.query = query;
  }
  async getSession(hash: string, now: number): Promise<Session | null> {
    const [r] = await this.query(
      "SELECT owner_id, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?",
      [hash, now],
    );
    return r
      ? { ownerId: String(r.owner_id), expiresAt: Number(r.expires_at) }
      : null;
  }
  async putSession(hash: string, session: Session) {
    await this.query(
      "INSERT INTO sessions (token_hash, owner_id, expires_at) VALUES (?, ?, ?)",
      [hash, session.ownerId, session.expiresAt],
    );
  }
  async findIdempotent(ownerId: string, key: string): Promise<Link | null> {
    const [r] = await this.query(
      "SELECT * FROM links WHERE owner_id = ? AND idempotency_key = ?",
      [ownerId, key],
    );
    return r ? linkFromRow(r) : null;
  }
  async insertLink(link: Link): Promise<InsertResult> {
    const [r] = await this.query(
      `INSERT INTO links (code, owner_id, target_url, request_hash, idempotency_key, created_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING *`,
      [
        link.code,
        link.ownerId,
        link.targetUrl,
        link.requestHash,
        link.idempotencyKey,
        link.createdAt,
        link.expiresAt,
        null,
      ],
    );
    if (r) return { kind: "inserted", link: linkFromRow(r) };
    const prior = await this.findIdempotent(link.ownerId, link.idempotencyKey);
    return prior ? { kind: "replayed", link: prior } : { kind: "collision" };
  }
  async findState(code: string): Promise<LinkState | null> {
    const [r] = await this.query(
      "SELECT code, expires_at, revoked_at FROM links WHERE code = ?",
      [code],
    );
    return r
      ? {
          code: String(r.code),
          expiresAt: r.expires_at === null ? null : Number(r.expires_at),
          revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
        }
      : null;
  }
  async findTarget(code: string) {
    const [r] = await this.query(
      "SELECT target_url FROM links WHERE code = ?",
      [code],
    );
    return r ? String(r.target_url) : null;
  }
  async listLinks(ownerId: string, limit: number, cursor?: Cursor) {
    const rows = cursor
      ? await this.query(
          `SELECT * FROM links WHERE owner_id = ? AND (created_at < ? OR (created_at = ? AND code < ?))
          ORDER BY created_at DESC, code DESC LIMIT ?`,
          [ownerId, cursor.createdAt, cursor.createdAt, cursor.code, limit],
        )
      : await this.query(
          "SELECT * FROM links WHERE owner_id = ? ORDER BY created_at DESC, code DESC LIMIT ?",
          [ownerId, limit],
        );
    return rows.map(linkFromRow);
  }
  async revoke(ownerId: string, code: string, now: number) {
    const rows = await this.query(
      "UPDATE links SET revoked_at = COALESCE(revoked_at, ?) WHERE code = ? AND owner_id = ? RETURNING code",
      [now, code, ownerId],
    );
    return rows.length > 0;
  }
  async recordClick(code: string, day: string) {
    await this.query(
      `INSERT INTO click_daily (code, day, clicks) VALUES (?, ?, 1)
      ON CONFLICT (code, day) DO UPDATE SET clicks = click_daily.clicks + 1`,
      [code, day],
    );
  }
  async clickTotals(ownerId: string, codes: string[]) {
    if (codes.length === 0) return {};
    const rows = await this.query(
      `SELECT l.code, COALESCE(SUM(c.clicks), 0) AS total FROM links l
      LEFT JOIN click_daily c ON c.code = l.code WHERE l.owner_id = ? AND l.code IN (${codes.map(() => "?").join(",")}) GROUP BY l.code`,
      [ownerId, ...codes],
    );
    return Object.fromEntries(
      rows.map((r) => [String(r.code), Number(r.total)]),
    );
  }
  async ping() {
    await this.query("SELECT 1 AS alive");
  }
  async cleanup(now: number) {
    await this.query("DELETE FROM sessions WHERE expires_at <= ?", [now]);
  }
}
