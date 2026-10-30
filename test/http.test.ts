import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { AUTH_HEADER } from "../src/http.js";
import { createRuntime } from "../src/runtime.js";
import { TOKEN_PATH } from "../src/constants.js";

const KEY = "super-secret/key+value=99";
const URL = "https://wallabag.test";
const recordSchema = z.object({ id: z.string(), title: z.string() });

function runtimeFor(options: {
  fetchImpl: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}) {
  return createRuntime(
    loadConfig({ WALLABAG_BASE_URL: URL, WALLABAG_ACCESS_TOKEN: KEY, ...options.env }, []),
    {
      fetchImpl: options.fetchImpl,
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  );
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  const record = input as { url?: unknown; href?: unknown };
  if (typeof record.url === "string") return record.url;
  if (typeof record.href === "string") return record.href;
  return "";
}

function requestBody(init: RequestInit | undefined): string {
  const body = init?.body;
  return typeof body === "string" ? body : "";
}

describe("HttpClient", () => {
  it("sends the token as Authorization Bearer, caches the parsed body, and does not put the token in the url", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      urls.push(requestUrl(input));
      return Promise.resolve(Response.json({ id: "rec-1", title: "Widget" }));
    });
    let now = 0;
    const runtime = runtimeFor({
      fetchImpl,
      env: { WALLABAG_CACHE_TTL_SEC: "30" },
      now: () => now,
    });
    const first = await runtime.client.getJson(
      { path: "api/entries", query: undefined, ttlSec: 30 },
      recordSchema,
    );
    const second = await runtime.client.getJson(
      { path: "api/entries", query: undefined, ttlSec: 30 },
      recordSchema,
    );
    expect(first).toEqual({ id: "rec-1", title: "Widget" });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get(AUTH_HEADER)).toBe(`Bearer ${KEY}`);
    expect(urls.join("\n")).not.toContain(KEY);
    expect(urls[0]).toBe(`${URL}/api/entries`);
    now = 31_000;
    await runtime.client.getJson(
      { path: "api/entries", query: undefined, ttlSec: 30 },
      recordSchema,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not spend the rate limit on a cache hit and blocks the next miss", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ id: "1", title: "A" })),
    );
    const runtime = runtimeFor({
      fetchImpl,
      env: { WALLABAG_PER_MINUTE: "1", WALLABAG_CACHE_TTL_SEC: "60" },
      now: () => 0,
    });
    await runtime.client.getJson(
      { path: "api/entries", query: undefined, ttlSec: 60 },
      recordSchema,
    );
    await runtime.client.getJson(
      { path: "api/entries", query: undefined, ttlSec: 60 },
      recordSchema,
    );
    await expect(
      runtime.client.getJson({ path: "api/tags", query: undefined, ttlSec: 60 }, recordSchema),
    ).rejects.toMatchObject({ code: "rate_limit" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("redacts a secret that the upstream body or a network error tried to echo", async () => {
    const logs: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(() => {
      throw new Error(`connect failed ${KEY} ${encodeURIComponent(KEY)}`);
    });
    const runtime = createRuntime(
      loadConfig({ WALLABAG_BASE_URL: URL, WALLABAG_ACCESS_TOKEN: KEY }, []),
      {
        fetchImpl,
        logger: { info: () => undefined, error: (message) => logs.push(message) },
      },
    );
    await expect(
      runtime.client.getJson({ path: "api/entries", query: undefined, ttlSec: 0 }, recordSchema),
    ).rejects.toThrow(ConnectorError);
    try {
      await runtime.client.getJson(
        { path: "api/entries", query: undefined, ttlSec: 0 },
        recordSchema,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain(encodeURIComponent(KEY));
      expect(error.message).toContain("[redacted]");
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("refuses to put the token in the query string", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ id: "1", title: "A" })),
    );
    const runtime = runtimeFor({ fetchImpl });
    await expect(
      runtime.client.getJson(
        { path: "api/search", query: { term: KEY }, ttlSec: 0 },
        recordSchema,
      ),
    ).rejects.toThrow(/request URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps 401, 404, 422, and 429 with Retry-After", async () => {
    const unauthorized = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(`bad ${KEY}`, { status: 401 })),
    );
    await expect(
      runtimeFor({ fetchImpl: unauthorized }).client.getJson(
        { path: "api/entries", query: undefined, ttlSec: 0 },
        recordSchema,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });

    const notFound = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("missing", { status: 404 })),
    );
    await expect(
      runtimeFor({ fetchImpl: notFound }).client.getJson(
        { path: "api/entries", query: undefined, ttlSec: 0 },
        recordSchema,
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    const invalid = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ message: "bad field" }), { status: 422 })),
    );
    await expect(
      runtimeFor({ fetchImpl: invalid }).client.getJson(
        { path: "api/entries", query: undefined, ttlSec: 0 },
        recordSchema,
      ),
    ).rejects.toMatchObject({ code: "input" });

    const limited = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(`slow ${KEY}`, { status: 429, headers: { "retry-after": "4" } }),
      ),
    );
    try {
      await runtimeFor({ fetchImpl: limited }).client.getJson(
        { path: "api/entries", query: undefined, ttlSec: 0 },
        recordSchema,
      );
      throw new Error("expected rate limit");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.code).toBe("rate_limit");
      expect(error.retryAfterSeconds).toBe(4);
      expect(error.message).not.toContain(KEY);
    }
  });

  it("maps timeout", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error("missing abort signal"));
          return;
        }
        const abort = (): void => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    const timeoutRuntime = runtimeFor({
      fetchImpl: hanging,
      env: { WALLABAG_TIMEOUT_MS: "1000" },
    });
    await expect(
      timeoutRuntime.client.getJson(
        { path: "api/entries", query: undefined, ttlSec: 0 },
        recordSchema,
      ),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("fetches a password grant token before the first API call", async () => {
    const access = "issued-access-token-value";
    const refresh = "issued-refresh-token-value";
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith(`/${TOKEN_PATH}`)) {
        expect(init?.method).toBe("POST");
        expect(requestBody(init)).toContain("grant_type=password");
        expect(requestBody(init)).not.toContain(access);
        return Promise.resolve(
          Response.json({
            access_token: access,
            refresh_token: refresh,
            expires_in: 3600,
            token_type: "bearer",
          }),
        );
      }
      const headers = new Headers(init?.headers);
      expect(headers.get(AUTH_HEADER)).toBe(`Bearer ${access}`);
      return Promise.resolve(Response.json({ id: "1", title: "A" }));
    });
    const runtime = createRuntime(
      loadConfig(
        {
          WALLABAG_BASE_URL: URL,
          WALLABAG_CLIENT_ID: "client-id-value",
          WALLABAG_CLIENT_SECRET: "client-secret-value",
          WALLABAG_USERNAME: "baguser",
          WALLABAG_PASSWORD: "bag-password-value",
        },
        [],
      ),
      { fetchImpl },
    );
    const json = await runtime.client.getJson(
      { path: "api/entries", query: undefined, ttlSec: 0 },
      recordSchema,
    );
    expect(json).toEqual({ id: "1", title: "A" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses a pre-issued access token until HTTP 401, then password-grant refresh", async () => {
    const issued = "preissued-access-token-xx";
    const next = "rotated-access-token-value";
    let tokens = 0;
    let apis = 0;
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith(`/${TOKEN_PATH}`)) {
        tokens += 1;
        expect(requestBody(init)).toContain("grant_type=password");
        return Promise.resolve(
          Response.json({
            access_token: next,
            refresh_token: "refresh-token-value-zz",
            expires_in: 3600,
            token_type: "bearer",
          }),
        );
      }
      apis += 1;
      const headers = new Headers(init?.headers);
      if (apis === 1) {
        expect(headers.get(AUTH_HEADER)).toBe(`Bearer ${issued}`);
        return Promise.resolve(new Response("expired", { status: 401 }));
      }
      expect(headers.get(AUTH_HEADER)).toBe(`Bearer ${next}`);
      return Promise.resolve(Response.json({ id: "3", title: "C" }));
    });
    const runtime = createRuntime(
      loadConfig(
        {
          WALLABAG_BASE_URL: URL,
          WALLABAG_ACCESS_TOKEN: issued,
          WALLABAG_CLIENT_ID: "client-id-value",
          WALLABAG_CLIENT_SECRET: "client-secret-value",
          WALLABAG_USERNAME: "baguser",
          WALLABAG_PASSWORD: "bag-password-value",
        },
        [],
      ),
      { fetchImpl },
    );
    const json = await runtime.client.getJson(
      { path: "api/entries", query: undefined, ttlSec: 0 },
      recordSchema,
    );
    expect(json).toEqual({ id: "3", title: "C" });
    expect(tokens).toBe(1);
    expect(apis).toBe(2);
  });

  it("refreshes on HTTP 401 when password grant credentials are set", async () => {
    const first = "first-access-token-value";
    const second = "second-access-token-value";
    let tokens = 0;
    let apis = 0;
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith(`/${TOKEN_PATH}`)) {
        tokens += 1;
        const body = requestBody(init);
        if (tokens === 1) {
          expect(body).toContain("grant_type=password");
          return Promise.resolve(
            Response.json({
              access_token: first,
              refresh_token: "refresh-token-value-xx",
              expires_in: 3600,
              token_type: "bearer",
            }),
          );
        }
        expect(body).toContain("grant_type=refresh_token");
        return Promise.resolve(
          Response.json({
            access_token: second,
            refresh_token: "refresh-token-value-yy",
            expires_in: 3600,
            token_type: "bearer",
          }),
        );
      }
      apis += 1;
      const headers = new Headers(init?.headers);
      if (apis === 1) {
        expect(headers.get(AUTH_HEADER)).toBe(`Bearer ${first}`);
        return Promise.resolve(new Response("expired", { status: 401 }));
      }
      expect(headers.get(AUTH_HEADER)).toBe(`Bearer ${second}`);
      return Promise.resolve(Response.json({ id: "2", title: "B" }));
    });
    const runtime = createRuntime(
      loadConfig(
        {
          WALLABAG_BASE_URL: URL,
          WALLABAG_CLIENT_ID: "client-id-value",
          WALLABAG_CLIENT_SECRET: "client-secret-value",
          WALLABAG_USERNAME: "baguser",
          WALLABAG_PASSWORD: "bag-password-value",
        },
        [],
      ),
      { fetchImpl },
    );
    const json = await runtime.client.getJson(
      { path: "api/entries", query: undefined, ttlSec: 0 },
      recordSchema,
    );
    expect(json).toEqual({ id: "2", title: "B" });
    expect(tokens).toBe(2);
    expect(apis).toBe(2);
  });
});
