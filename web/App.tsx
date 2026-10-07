import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api } from "./api";
import type { LinkView, LinkPage } from "./api";

const date = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
export function App() {
  const [ready, setReady] = useState(false);
  const [links, setLinks] = useState<LinkView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [alias, setAlias] = useState("");
  const [expiry, setExpiry] = useState("0");
  const [result, setResult] = useState<LinkView | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const pending = useRef<{ key: string; body: string } | null>(null);
  const bootstrap = useRef<Promise<void> | null>(null);

  async function refresh(next?: string) {
    setRefreshing(true);
    try {
      const page = await api<LinkPage>(
        `/api/v1/links?limit=20${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
      );
      setLinks((old) =>
        next
          ? [
              ...old,
              ...page.items.filter(
                (item) => !old.some((l) => l.code === item.code),
              ),
            ]
          : page.items,
      );
      setCursor(page.nextCursor);
    } finally {
      setRefreshing(false);
    }
  }
  async function connect() {
    setError("");
    try {
      await api("/api/v1/session", { method: "POST" });
      await refresh();
      setReady(true);
    } catch (e) {
      setError(errorText(e));
    }
  }
  useEffect(() => {
    bootstrap.current ??= connect();
  }, []);
  function changed() {
    pending.current = null;
    setError("");
    setNotice("");
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    pending.current ??= {
      key: crypto.randomUUID(),
      body: JSON.stringify({
        targetUrl: target.trim(),
        ...(alias.trim() ? { alias: alias.trim() } : {}),
        ...(expiry !== "0"
          ? {
              expiresAt: new Date(
                Date.now() + Number(expiry) * 86400000,
              ).toISOString(),
            }
          : {}),
      }),
    };
    try {
      const link = await api<LinkView>("/api/v1/links", {
        method: "POST",
        headers: { "Idempotency-Key": pending.current.key },
        body: pending.current.body,
      });
      setResult(link);
      pending.current = null;
      setNotice("Your short link is ready.");
      // A failed refresh must not disguise a successful creation.
      try {
        await refresh();
      } catch {
        setError(
          "Your link was created. Refresh the list when the connection returns.",
        );
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Link copied.");
    } catch {
      setError("Copy is unavailable. Select and copy the link text.");
    }
  }
  async function revoke(code: string) {
    setRevoking(code);
    setError("");
    try {
      await api(`/api/v1/links/${encodeURIComponent(code)}`, {
        method: "DELETE",
      });
      setConfirm(null);
      setNotice("The link has been revoked.");
      if (result?.code === code) setResult(null);
      setLinks((old) =>
        old.map((l) =>
          l.code === code
            ? { ...l, status: "revoked", revokedAt: new Date().toISOString() }
            : l,
        ),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRevoking(null);
    }
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="wordmark" href="/">
            Shortlink<span className="wordmark-period">.</span>
          </a>
          <span className="workspace-label">Link workspace</span>
          <span className="privacy-label">Private to this browser</span>
        </div>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <p className="eyebrow">YOUR LINKS, IN ONE PLACE</p>
            <h1>
              Less URL.
              <br className="mobile-break" /> More possibility.
            </h1>
            <p className="intro">
              Create a short link. Decide how long it lives. Keep track of where
              it goes.
            </p>
          </div>
          <div className="heading-note">
            <span className="note-label">A little housekeeping</span>
            <p>
              Keep this browser’s cookies to retain access to your links. Your
              workspace lasts 30 days.
            </p>
          </div>
        </div>

        {error && (
          <div className="alert error" role="alert">
            {error}{" "}
            {!ready && (
              <button onClick={() => void connect()}>Reconnect</button>
            )}
          </div>
        )}
        <div className="sr-only" role="status" aria-live="polite">
          {notice}
        </div>
        <section className="create-section" aria-labelledby="create-title">
          <div className="create-heading">
            <span className="section-number">01</span>
            <div>
              <h2 id="create-title">Make it short</h2>
              <p>Start with a public HTTPS destination.</p>
            </div>
          </div>
          <form onSubmit={create}>
            <label htmlFor="target">Destination URL</label>
            <div className="target-row">
              <input
                id="target"
                type="url"
                placeholder="https://example.com/something-worth-sharing"
                required
                maxLength={2048}
                value={target}
                onChange={(e) => {
                  changed();
                  setTarget(e.target.value);
                }}
                disabled={!ready || busy}
                autoComplete="url"
              />
              <button
                className="primary-button"
                type="submit"
                disabled={!ready || busy}
              >
                {busy
                  ? "Creating…"
                  : ready
                    ? "Create short link"
                    : "Connecting…"}
              </button>
            </div>
            <div className="options-row">
              <div>
                <label htmlFor="alias">
                  Custom alias <span>optional</span>
                </label>
                <input
                  id="alias"
                  placeholder="e.g. autumn-guide"
                  value={alias}
                  minLength={4}
                  maxLength={32}
                  pattern="[a-zA-Z0-9_-]{4,32}"
                  onChange={(e) => {
                    changed();
                    setAlias(e.target.value);
                  }}
                  disabled={!ready || busy}
                />
                <p className="field-hint">
                  4–32 letters, numbers, hyphens, or underscores.
                </p>
              </div>
              <div>
                <label htmlFor="expiry">Expires after</label>
                <select
                  id="expiry"
                  value={expiry}
                  onChange={(e) => {
                    changed();
                    setExpiry(e.target.value);
                  }}
                  disabled={!ready || busy}
                >
                  <option value="0">Never</option>
                  <option value="1">24 hours</option>
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                </select>
                <p className="field-hint">
                  Expired links stop redirecting automatically.
                </p>
              </div>
            </div>
          </form>
          {result && (
            <div className="created-result">
              <div>
                <span className="result-label">Ready to share</span>
                <a href={result.shortUrl} target="_blank" rel="noreferrer">
                  {result.shortUrl}
                </a>
              </div>
              <button
                className="secondary-button"
                onClick={() => void copy(result.shortUrl)}
              >
                Copy link
              </button>
            </div>
          )}
        </section>

        <section className="library-section" aria-labelledby="library-title">
          <div className="library-heading">
            <div className="section-title">
              <span className="section-number">02</span>
              <div>
                <h2 id="library-title">Your link library</h2>
                <p>Counts include redirects recorded so far.</p>
              </div>
            </div>
            <button
              className="text-button"
              disabled={!ready || refreshing}
              onClick={() => {
                setError("");
                void refresh().catch((e) => setError(errorText(e)));
              }}
            >
              {refreshing ? "Refreshing…" : "Refresh list"}
            </button>
          </div>
          <div className="stats-row">
            <div>
              <span>Links in this view</span>
              <strong>{links.length.toString().padStart(2, "0")}</strong>
            </div>
            <div>
              <span>Active in this view</span>
              <strong>
                {links
                  .filter((l) => l.status === "active")
                  .length.toString()
                  .padStart(2, "0")}
              </strong>
            </div>
            <div>
              <span>Recorded redirects</span>
              <strong>
                {links
                  .reduce((total, l) => total + l.clicks, 0)
                  .toLocaleString()}
              </strong>
            </div>
          </div>
          {!ready && !error ? (
            <div className="empty-state">Opening your workspace…</div>
          ) : links.length === 0 ? (
            <div className="empty-state">
              <span className="empty-code">https://…</span>
              <h3>Your first link belongs here.</h3>
              <p>Create one above and it will appear in your library.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>LINK / DESTINATION</th>
                    <th>STATUS</th>
                    <th>REDIRECTS</th>
                    <th>EXPIRES</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {links.map((link) => (
                    <tr key={link.code}>
                      <td className="link-cell">
                        <a
                          className="short-link"
                          href={link.shortUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          /r/{link.code}
                        </a>
                        <span className="destination" title={link.targetUrl}>
                          {link.targetUrl}
                        </span>
                        <span className="created-date">
                          Created {date(link.createdAt)}
                        </span>
                      </td>
                      <td data-label="Status">
                        <span className={`badge ${link.status}`}>
                          {link.status}
                        </span>
                      </td>
                      <td className="click-count" data-label="Redirects">
                        {link.clicks.toLocaleString()}
                      </td>
                      <td className="expiry-date" data-label="Expires">
                        {link.expiresAt ? date(link.expiresAt) : "Never"}
                      </td>
                      <td className="action-cell">
                        <button
                          className="table-button"
                          aria-label={`Copy ${link.code}`}
                          onClick={() => void copy(link.shortUrl)}
                        >
                          Copy
                        </button>
                        {link.status === "active" &&
                          (confirm === link.code ? (
                            <div className="revoke-confirm">
                              <span>Revoke permanently?</span>
                              <button
                                disabled={revoking !== null}
                                onClick={() => void revoke(link.code)}
                              >
                                Confirm
                              </button>
                              <button onClick={() => setConfirm(null)}>
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              className="table-button danger"
                              aria-label={`Revoke ${link.code}`}
                              onClick={() => setConfirm(link.code)}
                            >
                              Revoke
                            </button>
                          ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {cursor && (
            <div className="load-more">
              <button
                className="secondary-button"
                disabled={refreshing}
                onClick={() =>
                  void refresh(cursor).catch((e) => setError(errorText(e)))
                }
              >
                Load older links
              </button>
            </div>
          )}
        </section>
        <footer>
          <span>Small links. Clear ownership.</span>
          <span>
            Destinations stay fixed. You can revoke a link at any time.
          </span>
        </footer>
      </main>
      {notice && (
        <div className="toast" aria-hidden="true" key={notice}>
          {notice}
        </div>
      )}
    </>
  );
}
