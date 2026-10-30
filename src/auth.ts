import { z } from "zod";
import { brandSecret, type BaseUrl, type Secret } from "./brand.js";
import { TOKEN_PATH } from "./constants.js";
import { ConnectorError } from "./errors.js";
import type { Logger } from "./log.js";
import { messageFromErrorBody } from "./parse.js";
import { redact, stripUrls } from "./redact.js";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.unknown().optional(),
});

export interface TokenSource {
  getAccessToken(): Promise<Secret>;
  refresh(): Promise<boolean>;
}

export interface PasswordGrant {
  readonly clientId: Secret;
  readonly clientSecret: Secret;
  readonly username: string;
  readonly password: Secret;
}

export interface OAuthClientOptions {
  baseUrl: BaseUrl;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  secrets: string[];
  userAgent: string;
  logger: Logger;
  accessToken: Secret | undefined;
  password: PasswordGrant | undefined;
  now?: () => number;
}

function snippet(text: string, secrets: readonly string[]): string {
  return stripUrls(redact(text, secrets)).replace(/\s+/g, " ").trim().slice(0, 180);
}

export class OAuthClient implements TokenSource {
  private readonly baseUrl: BaseUrl;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly secrets: string[];
  private readonly userAgent: string;
  private readonly logger: Logger;
  private readonly password: PasswordGrant | undefined;
  private readonly now: () => number;
  private accessToken: Secret | undefined;
  private refreshToken: Secret | undefined;
  private expiresAt = 0;
  private inflight: Promise<Secret> | undefined;
  private staticOnly: boolean;

  constructor(options: OAuthClientOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
    this.secrets = options.secrets;
    this.userAgent = options.userAgent;
    this.logger = options.logger;
    this.password = options.password;
    this.now = options.now ?? Date.now;
    this.accessToken = options.accessToken;
    this.staticOnly = options.password === undefined;
    if (options.accessToken !== undefined) {
      this.remember(options.accessToken);
      this.expiresAt = Number.POSITIVE_INFINITY;
    }
    if (options.password !== undefined) {
      this.remember(options.password.clientId);
      this.remember(options.password.clientSecret);
      this.remember(options.password.password);
    }
  }

  async getAccessToken(): Promise<Secret> {
    if (this.accessToken !== undefined && (this.staticOnly || this.now() < this.expiresAt)) {
      return this.accessToken;
    }
    if (this.inflight !== undefined) return this.inflight;
    this.inflight = this.obtain("bootstrap");
    try {
      return await this.inflight;
    } finally {
      this.inflight = undefined;
    }
  }

  async refresh(): Promise<boolean> {
    if (this.staticOnly) return false;
    if (this.inflight !== undefined) {
      await this.inflight;
      return this.accessToken !== undefined;
    }
    this.inflight = this.obtain("refresh");
    try {
      await this.inflight;
      return true;
    } catch {
      return false;
    } finally {
      this.inflight = undefined;
    }
  }

  private async obtain(reason: "bootstrap" | "refresh"): Promise<Secret> {
    if (this.refreshToken !== undefined && this.password !== undefined) {
      try {
        return await this.requestToken({
          grant_type: "refresh_token",
          client_id: this.password.clientId,
          client_secret: this.password.clientSecret,
          refresh_token: this.refreshToken,
        });
      } catch (error) {
        if (reason === "refresh") {
          this.logger.error("Wallabag refresh_token grant failed. Trying password grant.");
        } else if (error instanceof ConnectorError) {
          throw error;
        }
      }
    }
    if (this.password !== undefined) {
      return this.requestToken({
        grant_type: "password",
        client_id: this.password.clientId,
        client_secret: this.password.clientSecret,
        username: this.password.username,
        password: this.password.password,
      });
    }
    if (this.accessToken !== undefined) return this.accessToken;
    throw new ConnectorError(
      "config",
      "Wallabag has no access token. Set WALLABAG_ACCESS_TOKEN or password-grant credentials.",
    );
  }

  private async requestToken(fields: Readonly<Record<string, string>>): Promise<Secret> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    const url = new URL(TOKEN_PATH, `${this.baseUrl}/`);
    if (url.origin !== new URL(`${this.baseUrl}/`).origin) {
      throw new ConnectorError("config", "OAuth token path must stay on the configured base URL.");
    }
    const headers = new Headers();
    headers.set("accept", "application/json");
    headers.set("content-type", "application/x-www-form-urlencoded");
    headers.set("user-agent", this.userAgent);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: body.toString(),
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        const seconds = Math.max(1, Math.round(this.timeoutMs / 1000));
        throw new ConnectorError("timeout", `Wallabag token request timed out after ${seconds}s.`);
      }
      const raw = error instanceof Error ? error.message : "network error";
      throw new ConnectorError("network", `Wallabag token request failed: ${snippet(raw, this.secrets)}`);
    }
    const text = await response.text();
    if (!response.ok) {
      const detail = snippet(messageFromErrorBody(text), this.secrets);
      const suffix = detail.length > 0 ? `: ${detail}` : "";
      if (response.status === 401 || response.status === 403) {
        throw new ConnectorError("unauthorized", `Wallabag HTTP ${response.status} on token${suffix}`);
      }
      if (response.status === 400 || response.status === 422) {
        throw new ConnectorError("input", `Wallabag HTTP ${response.status} on token${suffix}`);
      }
      if (response.status === 429) {
        throw new ConnectorError("rate_limit", `Wallabag HTTP 429 on token${suffix}`);
      }
      throw new ConnectorError("upstream", `Wallabag HTTP ${response.status} on token${suffix}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new ConnectorError("upstream", "Wallabag token response was not JSON.");
    }
    const parsed = tokenResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ConnectorError("upstream", "Wallabag token response did not match the expected shape.");
    }
    const token = brandSecret(parsed.data.access_token);
    this.accessToken = token;
    this.remember(token);
    if (parsed.data.refresh_token !== undefined && parsed.data.refresh_token.length > 0) {
      this.refreshToken = brandSecret(parsed.data.refresh_token);
      this.remember(this.refreshToken);
    }
    const lifetime = parsed.data.expires_in ?? 3600;
    this.expiresAt = this.now() + Math.max(30, lifetime - 60) * 1000;
    this.staticOnly = false;
    return token;
  }

  private remember(value: string): void {
    if (value.length >= 8 && !this.secrets.includes(value)) this.secrets.push(value);
  }
}
