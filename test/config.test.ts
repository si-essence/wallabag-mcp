import { describe, expect, it } from "vitest";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { DEFAULT_TOOLSETS } from "../src/operations.js";

const KEY = "super-secret/key+value=99";
const URL = "http://127.0.0.1:80";

function messageOf(error: unknown): string {
  expect(error).toBeInstanceOf(ConnectorError);
  if (!(error instanceof ConnectorError)) throw error;
  return error.message;
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

const base = { WALLABAG_BASE_URL: URL, WALLABAG_ACCESS_TOKEN: KEY };

describe("loadConfig", () => {
  it("requires WALLABAG_BASE_URL", () => {
    const message = messageOf(catchError(() => loadConfig({ WALLABAG_ACCESS_TOKEN: KEY }, [])));
    expect(message).toContain("WALLABAG_BASE_URL");
    expect(message).toContain("required");
    expect(message).not.toContain(KEY);
  });

  it("requires an access token or a complete password grant", () => {
    const message = messageOf(catchError(() => loadConfig({ WALLABAG_BASE_URL: URL }, [])));
    expect(message).toContain("WALLABAG_ACCESS_TOKEN");
    expect(message).toContain("password-grant");
  });

  it("rejects a partial password grant", () => {
    const message = messageOf(
      catchError(() =>
        loadConfig({ WALLABAG_BASE_URL: URL, WALLABAG_CLIENT_ID: "client-id-value" }, []),
      ),
    );
    expect(message).toContain("password grant");
    expect(message).not.toContain("client-id-value");
  });

  it("applies defaults when url and token are set", () => {
    const config = loadConfig(base, []);
    expect(config.accessToken).toBe(KEY);
    expect(config.baseUrl).toBe(URL);
    expect(config.allowWrites).toBe(false);
    expect(config.toolsets).toEqual([...DEFAULT_TOOLSETS]);
    expect(config.perMinute).toBe(30);
    expect(config.timeoutMs).toBe(20_000);
    expect(config.contact).toBe("contact@example.com");
    expect(config.transport).toBe("stdio");
    expect(config.port).toBe(3000);
    expect(config.cacheTtlSec).toBe(60);
    expect(config.userAgent).toBe(`${CONNECTOR_NAME}/${CONNECTOR_VERSION} (contact@example.com)`);
  });

  it("accepts a base URL with a path prefix", () => {
    const config = loadConfig(
      { ...base, WALLABAG_BASE_URL: "https://example.com/wallabag" },
      [],
    );
    expect(config.baseUrl).toBe("https://example.com/wallabag");
  });

  it("lets --http override the transport", () => {
    expect(
      loadConfig({ ...base, MCP_TRANSPORT: "stdio" }, ["node", "app", "--http"]).transport,
    ).toBe("http");
    expect(loadConfig({ ...base, MCP_TRANSPORT: "http" }, []).transport).toBe("http");
  });

  it("enables writes only when WALLABAG_ALLOW_WRITES is the literal true", () => {
    expect(loadConfig({ ...base, WALLABAG_ALLOW_WRITES: "true" }, []).allowWrites).toBe(true);
    expect(loadConfig({ ...base, WALLABAG_ALLOW_WRITES: "TRUE" }, []).allowWrites).toBe(false);
    expect(loadConfig({ ...base, WALLABAG_ALLOW_WRITES: "1" }, []).allowWrites).toBe(false);
  });

  it("parses WALLABAG_TOOLSETS", () => {
    expect(loadConfig({ ...base, WALLABAG_TOOLSETS: "all" }, []).toolsets).toContain("user");
    expect(loadConfig({ ...base, WALLABAG_TOOLSETS: "entries, tags" }, []).toolsets).toEqual([
      "entries",
      "tags",
    ]);
  });

  it("rejects an unknown toolset without echoing the value", () => {
    const message = messageOf(
      catchError(() => loadConfig({ ...base, WALLABAG_TOOLSETS: "nope" }, [])),
    );
    expect(message).toContain("WALLABAG_TOOLSETS");
    expect(message).not.toContain("nope");
  });

  it("reports invalid fields without the rejected value or secrets", () => {
    const message = messageOf(
      catchError(() => loadConfig({ ...base, PORT: "nope", MCP_TRANSPORT: "sse" }, [])),
    );
    expect(message).toContain("PORT");
    expect(message).toContain("MCP_TRANSPORT");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("nope");
    expect(message).not.toContain("sse");
  });

  it("rejects a short access token without echoing it", () => {
    const message = messageOf(
      catchError(() => loadConfig({ WALLABAG_BASE_URL: URL, WALLABAG_ACCESS_TOKEN: "short" }, [])),
    );
    expect(message).toContain("WALLABAG_ACCESS_TOKEN");
    expect(message).not.toContain("short");
  });

  it("rejects a base url or contact that contains the token", () => {
    const inUrl = messageOf(
      catchError(() =>
        loadConfig({ WALLABAG_ACCESS_TOKEN: KEY, WALLABAG_BASE_URL: `https://example.invalid/${KEY}` }, []),
      ),
    );
    expect(inUrl).toContain("contains_secret");
    expect(inUrl).not.toContain(KEY);

    const inContact = messageOf(
      catchError(() => loadConfig({ ...base, WALLABAG_CONTACT: KEY }, [])),
    );
    expect(inContact).toContain("WALLABAG_CONTACT");
    expect(inContact).not.toContain(KEY);
  });

  it("rejects userinfo and query strings on the base url", () => {
    const userinfo = messageOf(
      catchError(() =>
        loadConfig({ WALLABAG_BASE_URL: "https://user:pass@example.invalid", WALLABAG_ACCESS_TOKEN: KEY }, []),
      ),
    );
    expect(userinfo).toContain("userinfo");
    expect(userinfo).not.toContain("pass");

    const query = messageOf(
      catchError(() =>
        loadConfig(
          { WALLABAG_BASE_URL: `https://example.invalid/v1?api_key=${KEY}`, WALLABAG_ACCESS_TOKEN: KEY },
          [],
        ),
      ),
    );
    expect(query).toContain("WALLABAG_BASE_URL");
    expect(query).not.toContain(KEY);
  });
});
