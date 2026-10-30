import { OAuthClient } from "./auth.js";
import { CONNECTOR_NAME } from "./constants.js";
import type { Config } from "./config.js";
import { TtlCache } from "./cache.js";
import { HttpClient } from "./http.js";
import { createLogger, type Logger } from "./log.js";
import { SlidingWindowLimiter } from "./rate-limit.js";

export interface Runtime {
  config: Config;
  client: HttpClient;
  secrets: readonly string[];
  logger: Logger;
  cacheTtlSec: number;
}

export interface RuntimeOverrides {
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: Logger;
}

export function createRuntime(config: Config, overrides: RuntimeOverrides = {}): Runtime {
  const now = overrides.now ?? Date.now;
  const secrets: string[] = [];
  const logger = overrides.logger ?? createLogger(secrets);
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const tokens = new OAuthClient({
    baseUrl: config.baseUrl,
    fetchImpl,
    timeoutMs: config.timeoutMs,
    secrets,
    userAgent: config.userAgent,
    logger,
    accessToken: config.accessToken,
    password: config.password,
    now,
  });
  const client = new HttpClient({
    baseUrl: config.baseUrl,
    fetchImpl,
    timeoutMs: config.timeoutMs,
    secrets,
    cache: new TtlCache(now),
    limiter: new SlidingWindowLimiter(config.perMinute, 60_000, now),
    userAgent: config.userAgent,
    logger,
    tokenSource: tokens,
    label: CONNECTOR_NAME,
  });
  return {
    config,
    client,
    secrets,
    logger,
    cacheTtlSec: config.cacheTtlSec,
  };
}
