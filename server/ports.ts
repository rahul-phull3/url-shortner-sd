import type { Cursor, InsertResult, Link, LinkState } from "./domain.ts";

export type Session = { ownerId: string; expiresAt: number };
export interface Repository {
  getSession(hash: string, now: number): Promise<Session | null>;
  putSession(hash: string, session: Session): Promise<void>;
  findIdempotent(ownerId: string, key: string): Promise<Link | null>;
  insertLink(link: Link): Promise<InsertResult>;
  findState(code: string): Promise<LinkState | null>;
  findTarget(code: string): Promise<string | null>;
  listLinks(ownerId: string, limit: number, cursor?: Cursor): Promise<Link[]>;
  revoke(ownerId: string, code: string, now: number): Promise<boolean>;
  recordClick(code: string, day: string): Promise<void>;
  clickTotals(
    ownerId: string,
    codes: string[],
  ): Promise<Record<string, number>>;
  ping(): Promise<void>;
  cleanup(now: number): Promise<void>;
}
export interface TargetCache {
  get(code: string): Promise<string | null>;
  set(code: string, target: string): Promise<void>;
}
export interface RateLimiter {
  consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; remaining: number; retryAfter: number }>;
  ping(): Promise<void>;
}
