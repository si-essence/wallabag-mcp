import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { OPERATIONS, toolIsWrite, toolNames, type Operation } from "../src/operations.js";
import { decideWrite, WRITES_DISABLED } from "../src/write-gate.js";
import { jsonFetch, jsonResponse, runtimeFor, TOKEN, type CapturedRequest } from "./harness.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const TOOL_NAMES = toolNames();
const WRITE_OPS = OPERATIONS.filter((operation) => operation.write);

function leakyBody(): Record<string, unknown> {
  return {
    id: 1,
    username: "ada",
    email: "ada@example.com",
    client_secret: "other-secret-key-value",
    password: "hunter2-secret-value",
    token: "jwt-token-value-xxxx",
    refresh_token: "refresh-token-value-xx",
    title: `hello ${TOKEN}`,
    stack: "at /var/www/wallabag/app.php:10",
  };
}

function argsFor(operation: Operation): Record<string, unknown> {
  const args: Record<string, unknown> = { action: operation.action };
  if (Object.keys(operation.sampleParams).length > 0) args["params"] = operation.sampleParams;
  if (Object.keys(operation.sampleQuery).length > 0) args["query"] = operation.sampleQuery;
  if (operation.sampleBody !== undefined) args["body"] = operation.sampleBody;
  return args;
}

async function withClient(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const runtime = runtimeFor(fetchImpl, extra);
  const connected = await connectServer(runtime);
  try {
    await run(connected.client);
  } finally {
    await connected.close();
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; json: Record<string, unknown> | null }> {
  const result = readToolText(await client.callTool({ name, arguments: args }));
  expect(result.text).not.toContain(TOKEN);
  if (result.isError) return { ...result, json: null };
  return { ...result, json: JSON.parse(result.text) as Record<string, unknown> };
}

describe("wallabag tools", () => {
  it("publishes every tool with a compact description and confirm on writes", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse(leakyBody()));
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(TOOL_NAMES);
      for (const tool of listed.tools) {
        const description = tool.description ?? "";
        expect(description).toContain("action help");
        expect(description.length).toBeGreaterThan(40);
        expect(description).not.toContain("bodyFields");
        const schema = JSON.stringify(tool.inputSchema);
        expect(schema).toContain("help");
        if (toolIsWrite(tool.name)) expect(schema).toContain("confirm");
        else expect(schema).not.toContain("confirm");
      }
    });
  });

  it("scopes the published set to WALLABAG_TOOLSETS", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({ ok: true }));
    await withClient(fetchImpl, { WALLABAG_TOOLSETS: "entries,info" }, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "wallabag_entries",
        "wallabag_info",
      ]);
    });
    await withClient(fetchImpl, { WALLABAG_TOOLSETS: undefined }, async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        "wallabag_annotations",
        "wallabag_config",
        "wallabag_entries",
        "wallabag_info",
        "wallabag_search",
        "wallabag_tags",
      ]);
      expect(names).not.toContain("wallabag_user");
    });
  });

  it("describes one action without calling upstream", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse(leakyBody()));
    await withClient(fetchImpl, {}, async (client) => {
      const described = await call(client, "wallabag_entries", {
        action: "help",
        target: "post",
      });
      expect(described.isError).toBe(false);
      expect(described.json).toMatchObject({
        action: "post",
        method: "POST",
        path: "/api/entries",
        write: true,
      });
      expect(calls).toHaveLength(0);
    });
  });

  it("redacts account secrets and drops stack traces", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (captured.authorization !== `Bearer ${TOKEN}`) {
        throw new Error("missing Authorization Bearer header");
      }
      return jsonResponse(leakyBody());
    });
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await call(client, "wallabag_user", { action: "get" });
      expect(listed.isError).toBe(false);
      const raw = JSON.stringify(listed.json);
      expect(raw).toContain("ada");
      expect(raw).toContain("[redacted]");
      expect(raw).not.toContain("ada@example.com");
      expect(raw).not.toContain("other-secret-key-value");
      expect(raw).not.toContain("hunter2-secret-value");
      expect(raw).not.toContain("jwt-token-value-xxxx");
      expect(raw).not.toContain("app.php");
      expect(raw).not.toContain("stack");
      expect(calls[0]?.url).toBe("https://wallabag.test/api/user");
      expect(calls[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    });
  });

  it("blocks writes when WALLABAG_ALLOW_WRITES is not true", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ ok: true }));
    await withClient(fetchImpl, { WALLABAG_ALLOW_WRITES: "false" }, async (client) => {
      const result = await call(client, "wallabag_entries", {
        action: "delete_by_id",
        params: { entry: "4" },
        confirm: true,
      });
      expect(result.json).toMatchObject({
        executed: false,
        blocked: true,
        method: "DELETE",
        path: "api/entries/4",
      });
      expect(JSON.stringify(result.json)).toContain("WALLABAG_ALLOW_WRITES");
      expect(calls).toHaveLength(0);
    });
  });

  it("previews a write without confirm and executes when confirm is true", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ id: 9, url: "https://example.com/a" }));
    await withClient(fetchImpl, {}, async (client) => {
      const preview = await call(client, "wallabag_entries", {
        action: "post",
        body: { url: "https://example.com/a" },
      });
      expect(preview.json).toMatchObject({ executed: false, dry_run: true, method: "POST" });
      expect(calls).toHaveLength(0);

      const created = await call(client, "wallabag_entries", {
        action: "post",
        body: { url: "https://example.com/a" },
        confirm: true,
      });
      expect(created.isError).toBe(false);
      expect(created.json).toMatchObject({ executed: true, dry_run: false });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("POST");
    });
  });

  it("rejects confirm false and the string true", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ ok: true }));
    await withClient(fetchImpl, {}, async (client) => {
      const asFalse = await call(client, "wallabag_entries", {
        action: "delete_by_id",
        params: { entry: "4" },
        confirm: false,
      });
      expect(asFalse.isError).toBe(true);
      const asString = await call(client, "wallabag_entries", {
        action: "delete_by_id",
        params: { entry: "4" },
        confirm: "true",
      });
      expect(asString.isError).toBe(true);
      expect(asString.text).toContain("confirm");
      expect(calls).toHaveLength(0);
    });
  });
});

describe("every registered tool", () => {
  it("guard: every tool is called as a read or a confirmed write, and every write is previewed", async () => {
    const seen = new Set<string>();
    const previewed = new Set<string>();
    const reachable = new Set<string>();
    const { fetchImpl, calls } = jsonFetch((captured: CapturedRequest) => {
      if (captured.authorization !== `Bearer ${TOKEN}`) {
        throw new Error("missing Authorization Bearer header");
      }
      if (captured.url.includes(TOKEN) || captured.url.includes(encodeURIComponent(TOKEN))) {
        throw new Error("token leaked into the url");
      }
      return jsonResponse(leakyBody());
    });
    await withClient(fetchImpl, { WALLABAG_PER_MINUTE: "300" }, async (client) => {
      const listed = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(listed).toEqual(TOOL_NAMES);
      for (const operation of OPERATIONS) {
        reachable.add(`${operation.method} ${operation.path}`);
        if (operation.write) {
          calls.length = 0;
          const preview = await call(client, operation.tool, argsFor(operation));
          expect(preview.isError, `${operation.tool} ${operation.action} preview`).toBe(false);
          expect(preview.json).toMatchObject({
            executed: false,
            dry_run: true,
            blocked: false,
            method: operation.method,
          });
          expect(String(preview.json?.["path"]).startsWith("api/")).toBe(true);
          expect(calls).toHaveLength(0);
          previewed.add(operation.tool);
        }
        calls.length = 0;
        const args = operation.write ? { ...argsFor(operation), confirm: true } : argsFor(operation);
        const result = await call(client, operation.tool, args);
        expect(result.isError, `${operation.tool} ${operation.action}`).toBe(false);
        expect(result.text).not.toContain("ada@example.com");
        expect(result.text).not.toContain("hunter2-secret-value");
        expect(result.text).not.toContain("app.php");
        if (!operation.revealSecret) expect(result.text).not.toContain("other-secret-key-value");
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0]?.authorization).toBe(`Bearer ${TOKEN}`);
        expect(calls[0]?.method).toBe(operation.method);
        seen.add(operation.tool);
      }
    });
    expect([...seen].sort()).toEqual(TOOL_NAMES);
    const writeTools = [...new Set(WRITE_OPS.map((operation) => operation.tool))].sort();
    for (const name of writeTools) expect(previewed.has(name), name).toBe(true);
    expect(OPERATIONS.length).toBe(29);
    expect(reachable.size).toBe(29);
  });
});

describe("error paths", () => {
  it("maps 401, 404, 422, and 429 with Retry-After", async () => {
    const cases: { status: number; body: unknown; needle: string; retry?: string }[] = [
      {
        status: 401,
        body: { message: `Unauthorized ${TOKEN}`, stack: "at /tmp/wallabag/app.php:4" },
        needle: "[unauthorized]",
      },
      {
        status: 404,
        body: { title: "Entry not found", stack: "at /tmp/wallabag/x.php:2" },
        needle: "[not-found]",
      },
      {
        status: 422,
        body: { message: "url should not be empty" },
        needle: "[input]",
      },
      {
        status: 429,
        body: { message: `slow ${TOKEN}` },
        needle: "[rate-limit]",
        retry: "9",
      },
    ];
    for (const item of cases) {
      const { fetchImpl } = jsonFetch(() =>
        jsonResponse(
          item.body,
          item.status,
          item.retry === undefined ? {} : { "retry-after": item.retry },
        ),
      );
      await withClient(fetchImpl, {}, async (client) => {
        const result = await call(client, "wallabag_info", { action: "get" });
        expect(result.isError).toBe(true);
        expect(result.text).toContain(item.needle);
        expect(result.text).not.toContain(TOKEN);
        expect(result.text).not.toContain("/tmp/");
        expect(result.text).not.toContain("app.php");
        if (item.retry !== undefined) expect(result.text).toContain(`retry after ${item.retry}s`);
      });
    }
  });
});

describe("write gate", () => {
  const plan = {
    method: "DELETE" as const,
    path: "api/entries/1",
    query: undefined,
    body: undefined,
    summary: "delete",
    warnings: ["This deletes data on the Wallabag server. It may be irreversible."],
    revealSecret: false,
  };

  it("previews when confirm is omitted", () => {
    const decision = decideWrite(true, undefined, plan, []);
    expect(decision.kind).toBe("preview");
    if (decision.kind !== "preview") return;
    expect(decision.payload).toMatchObject({ executed: false, dry_run: true, blocked: false });
  });

  it("blocks when confirm is true and writes are disabled", () => {
    const decision = decideWrite(false, true, plan, []);
    expect(decision.kind).toBe("preview");
    if (decision.kind !== "preview") return;
    expect(decision.payload).toMatchObject({ blocked: true, reason: WRITES_DISABLED });
  });

  it("executes only for boolean true plus allow writes", () => {
    expect(decideWrite(true, true, plan, []).kind).toBe("execute");
  });
});
