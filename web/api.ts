export type LinkView = {
  code: string;
  shortUrl: string;
  targetUrl: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
  clicks: number;
};
export type LinkPage = { items: LinkView[]; nextCursor: string | null };
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      credentials: "same-origin",
      headers: {
        "X-Requested-With": "shortlink",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (response.status === 204) return undefined as T;
    const data = (await response.json()) as { error?: { message?: string } };
    if (!response.ok)
      throw new Error(
        data.error?.message ?? "The request could not be completed.",
      );
    return data as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw new Error("The request timed out. You can safely try again.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
