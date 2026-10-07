export type Config = {
  baseUrl: string;
  metricsToken: string;
  logLevel: string;
  trustProxyHops: number;
};
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrl = (env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(
    /\/$/,
    "",
  );
  const url = new URL(baseUrl);
  if (
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !["https:", "http:"].includes(url.protocol)
  )
    throw new Error("PUBLIC_BASE_URL must be an HTTP(S) origin.");
  if (env.NODE_ENV === "production" && url.protocol !== "https:")
    throw new Error("Production requires an HTTPS PUBLIC_BASE_URL.");
  const metricsToken = env.METRICS_TOKEN ?? "";
  if (metricsToken.length < 32)
    throw new Error("METRICS_TOKEN must contain at least 32 characters.");
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? "0");
  if (
    !Number.isInteger(trustProxyHops) ||
    trustProxyHops < 0 ||
    trustProxyHops > 2
  )
    throw new Error("Invalid TRUST_PROXY_HOPS.");
  return {
    baseUrl,
    metricsToken,
    trustProxyHops,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
