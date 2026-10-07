import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { Repository, TargetCache } from "./ports.ts";

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export type Link = {
  code: string;
  ownerId: string;
  targetUrl: string;
  requestHash: string;
  idempotencyKey: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
};
export type LinkState = Pick<Link, "code" | "expiresAt" | "revokedAt">;
export type CreateInput = {
  targetUrl: string;
  alias?: string;
  expiresAt?: string;
};
export type Cursor = { createdAt: number; code: string };
export type InsertResult =
  { kind: "inserted" | "replayed"; link: Link } | { kind: "collision" };
export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const alphabet =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export function randomCode(): string {
  let code = "";
  while (code.length < 10) {
    for (const byte of randomBytes(16)) {
      if (byte < 248 && code.length < 10) code += alphabet[byte % 62];
    }
  }
  return code;
}

function privateLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(h) === 6) return true; // Literal IPv6 destinations are deliberately unsupported.
  return (
    h === "localhost" ||
    !h.includes(".") ||
    /\.(localhost|local|internal|test|invalid)$/.test(h)
  );
}

export function normalizeInput(
  input: CreateInput,
  baseUrl: string,
): CreateInput {
  let url: URL;
  try {
    url = new URL(input.targetUrl);
  } catch {
    throw new AppError(400, "INVALID_TARGET", "Enter an absolute HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    privateLiteral(url.hostname)
  )
    throw new AppError(
      400,
      "INVALID_TARGET",
      "Use a public HTTPS destination without credentials.",
    );
  if (url.origin === new URL(baseUrl).origin)
    throw new AppError(
      400,
      "REDIRECT_LOOP",
      "Choose a destination outside this short-link service.",
    );
  if (url.toString().length > 2048)
    throw new AppError(400, "INVALID_TARGET", "The destination is too long.");
  if (input.alias !== undefined && !/^[a-zA-Z0-9_-]{4,32}$/.test(input.alias))
    throw new AppError(
      400,
      "INVALID_ALIAS",
      "Aliases need 4–32 letters, digits, hyphens, or underscores.",
    );
  let expiresAt: string | undefined;
  if (input.expiresAt !== undefined) {
    const parsed = Date.parse(input.expiresAt);
    if (!Number.isFinite(parsed))
      throw new AppError(400, "INVALID_EXPIRY", "Use an ISO expiry date.");
    expiresAt = new Date(parsed).toISOString();
  }
  return {
    targetUrl: url.toString(),
    ...(input.alias ? { alias: input.alias } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

export function decodeCursor(value?: string): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    if (value.length > 160) throw new Error();
    const c = JSON.parse(Buffer.from(value, "base64url").toString());
    if (
      !Number.isSafeInteger(c.createdAt) ||
      c.createdAt < 0 ||
      !/^[a-zA-Z0-9_-]{4,32}$/.test(c.code)
    )
      throw new Error();
    return { createdAt: c.createdAt, code: c.code };
  } catch {
    throw new AppError(400, "INVALID_CURSOR", "The page cursor is invalid.");
  }
}
export const encodeCursor = (link: Link): string =>
  Buffer.from(
    JSON.stringify({ createdAt: link.createdAt, code: link.code }),
  ).toString("base64url");

export class LinkService {
  readonly repo: Repository;
  readonly cache: TargetCache;
  readonly baseUrl: string;
  readonly now: () => number;
  readonly code: () => string;
  constructor(
    repo: Repository,
    cache: TargetCache,
    baseUrl: string,
    now = Date.now,
    code = randomCode,
  ) {
    this.repo = repo;
    this.cache = cache;
    this.baseUrl = baseUrl;
    this.now = now;
    this.code = code;
  }

  async create(
    ownerId: string,
    raw: CreateInput,
    key: string,
  ): Promise<{ link: Link; replayed: boolean }> {
    if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(key))
      throw new AppError(
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "Supply an Idempotency-Key of 8–128 safe characters.",
      );
    const input = normalizeInput(raw, this.baseUrl);
    const hash = sha256(JSON.stringify(input));
    // Check a permanent replay before validating a now-past expiry.
    const prior = await this.repo.findIdempotent(ownerId, key);
    if (prior) {
      if (prior.requestHash !== hash)
        throw new AppError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This key belongs to a different request.",
        );
      return { link: prior, replayed: true };
    }
    const now = this.now();
    const expiresAt = input.expiresAt ? Date.parse(input.expiresAt) : null;
    if (
      expiresAt !== null &&
      (expiresAt <= now || expiresAt > now + 365 * 86400000)
    )
      throw new AppError(
        400,
        "INVALID_EXPIRY",
        "Expiry must be in the future, within 365 days.",
      );
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await this.repo.insertLink({
        code: input.alias ?? this.code(),
        ownerId,
        targetUrl: input.targetUrl,
        createdAt: now,
        expiresAt,
        revokedAt: null,
        idempotencyKey: key,
        requestHash: hash,
      });
      if (result.kind !== "collision") {
        if (result.link.requestHash !== hash)
          throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This key belongs to a different request.",
          );
        return { link: result.link, replayed: result.kind === "replayed" };
      }
      if (input.alias)
        throw new AppError(
          409,
          "ALIAS_TAKEN",
          "This alias is already reserved.",
        );
    }
    throw new AppError(
      503,
      "CODE_EXHAUSTED",
      "A code could not be allocated. Retry with the same key.",
    );
  }

  async resolve(code: string): Promise<string> {
    // A cached URL is never permission to redirect. State is read from the primary first.
    const state = await this.repo.findState(code);
    if (!state)
      throw new AppError(
        404,
        "LINK_NOT_FOUND",
        "This short link does not exist.",
      );
    if (
      state.revokedAt !== null ||
      (state.expiresAt !== null && state.expiresAt <= this.now())
    )
      throw new AppError(
        410,
        "LINK_GONE",
        "This short link has expired or was revoked.",
      );
    let target: string | null = null;
    try {
      target = await this.cache.get(code);
    } catch {
      /* optional cache */
    }
    if (target !== null) return target;
    target = await this.repo.findTarget(code);
    if (!target)
      throw new AppError(
        503,
        "STORAGE_UNAVAILABLE",
        "The destination is temporarily unavailable.",
      );
    try {
      await this.cache.set(code, target);
    } catch {
      /* primary remains authoritative */
    }
    return target;
  }

  view(link: Link) {
    return {
      code: link.code,
      shortUrl: `${this.baseUrl}/r/${link.code}`,
      targetUrl: link.targetUrl,
      createdAt: new Date(link.createdAt).toISOString(),
      expiresAt:
        link.expiresAt === null ? null : new Date(link.expiresAt).toISOString(),
      revokedAt:
        link.revokedAt === null ? null : new Date(link.revokedAt).toISOString(),
      status:
        link.revokedAt !== null
          ? "revoked"
          : link.expiresAt !== null && link.expiresAt <= this.now()
            ? "expired"
            : "active",
    };
  }
}
