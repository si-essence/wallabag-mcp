import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { redact, redactUnknown } from "../src/redact.js";
import { createRuntime } from "../src/runtime.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const KEY = "super-secret/key+value=99";
const ENCODED = encodeURIComponent(KEY);
const URL = "https://wallabag.test";

function assertNoKey(label: string, text: string): void {
  expect(text, label).not.toContain(KEY);
  expect(text, label).not.toContain(ENCODED);
}

describe("redact", () => {
  it("strips the secret, its url encoding, query params, and bearer tokens", () => {
    const raw = [
      `key=${KEY}`,
      `encoded=${ENCODED}`,
      `https://wallabag.test/oauth/v2/token?access_token=${KEY}&x=1`,
      `Authorization: Bearer ${KEY}`,
    ].join("\n");
    const cleaned = redact(raw, [KEY]);
    assertNoKey("redact", cleaned);
    expect(cleaned).toContain("access_token=[redacted]");
    expect(cleaned).toContain("Bearer [redacted]");
  });

  it("redacts nested email, token, and password and leaves usernames", () => {
    const cleaned = redactUnknown(
      {
        username: "ada",
        email: "ada@example.com",
        client_secret: KEY,
        token: "jwt-token-value-xxxx",
        refresh_token: "refresh-token-value-xx",
        password: "hunter2-secret-value",
      },
      [KEY],
    );
    const raw = JSON.stringify(cleaned);
    assertNoKey("nested", raw);
    expect(raw).toContain("ada");
    expect(raw).not.toContain("ada@example.com");
    expect(raw).not.toContain("jwt-token-value-xxxx");
    expect(raw).not.toContain("hunter2-secret-value");
  });

  it("redacts logger lines", () => {
    const lines: string[] = [];
    const logger = createLogger([KEY], (line) => {
      lines.push(line);
    });
    logger.error(`upstream said ${KEY}`);
    assertNoKey("logger", lines.join("\n"));
    expect(lines.join("\n")).toContain("[redacted]");
  });

  it("keeps the access token out of tool output, errors, and logs", async () => {
    const logs: string[] = [];
    const consoleLines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleLines.push(
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      );
    });
    let call = 0;
    const fetchImpl = vi.fn<typeof fetch>(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(Response.json({ id: 1, username: "ada", title: `hello ${KEY}` }));
      }
      return Promise.reject(new Error(`connect failed ${KEY} ${ENCODED}`));
    });
    const runtime = createRuntime(
      loadConfig(
        {
          WALLABAG_BASE_URL: URL,
          WALLABAG_ACCESS_TOKEN: KEY,
          WALLABAG_CACHE_TTL_SEC: "0",
          WALLABAG_TOOLSETS: "info",
        },
        [],
      ),
      {
        fetchImpl,
        logger: createLogger([KEY], (line) => {
          logs.push(line);
        }),
      },
    );
    const { client, close } = await connectServer(runtime);
    try {
      const ok = readToolText(
        await client.callTool({ name: "wallabag_info", arguments: { action: "get" } }),
      );
      const bad = readToolText(
        await client.callTool({ name: "wallabag_info", arguments: { action: "get" } }),
      );
      const leaked = readToolText(
        await client.callTool({
          name: "wallabag_info",
          arguments: { action: "get", query: { q: KEY } },
        }),
      );
      expect(ok.isError).toBe(false);
      expect(ok.text).toContain("[redacted]");
      assertNoKey("success output", ok.text);
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("[redacted]");
      assertNoKey("error output", bad.text);
      expect(leaked.isError).toBe(true);
      assertNoKey("query echo", leaked.text);
      expect(logs.length).toBeGreaterThan(0);
      assertNoKey("logs", logs.join("\n"));
      assertNoKey("stderr", consoleLines.join("\n"));
    } finally {
      spy.mockRestore();
      await close();
    }
  });
});
