#!/usr/bin/env node
/**
 * Live check against a real Wallabag server. Spawns dist/index.js over stdio.
 * Skips when WALLABAG_BASE_URL is unset, or when neither an access token nor a
 * password grant is configured. Prints pass/fail lines only.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const baseUrl = process.env["WALLABAG_BASE_URL"] ?? "";
const accessToken = process.env["WALLABAG_ACCESS_TOKEN"] ?? "";
const clientId = process.env["WALLABAG_CLIENT_ID"] ?? "";
const clientSecret = process.env["WALLABAG_CLIENT_SECRET"] ?? "";
const username = process.env["WALLABAG_USERNAME"] ?? "";
const password = process.env["WALLABAG_PASSWORD"] ?? "";
const allowWrites = process.env["WALLABAG_ALLOW_WRITES"] === "true";

/** @type {string[]} */
const secrets = [];
for (const value of [accessToken, clientId, clientSecret, password]) {
  if (value.length >= 8) secrets.push(value);
}

/**
 * @param {string} text
 */
function redact(text) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
    out = out.split(encodeURIComponent(secret)).join("[redacted]");
  }
  out = out.replace(/(authorization:\s*bearer\s+)\S+/gi, "Authorization: Bearer [redacted]");
  out = out.replace(
    /([?&#](?:api_key|apikey|api-key|token|key|password|access_token|refresh_token)=)[^&\s#]+/gi,
    "$1[redacted]",
  );
  out = out.replace(
    /"(apiKey|key|secret|token|refreshToken|refresh_token|password|email|client_secret|access_token)"\s*:\s*"[^"]*"/gi,
    '"$1":"[redacted]"',
  );
  return out;
}

const writeLine = console.log.bind(console);
console.log = (line) => writeLine(redact(String(line)));
console.error = (line) => writeLine(redact(String(line)));

let failed = 0;
let passed = 0;

/**
 * @param {string} name
 * @param {boolean} ok
 */
function record(name, ok) {
  if (ok) passed += 1;
  else failed += 1;
  writeLine(`${ok ? "PASS" : "FAIL"}  ${name}`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {string | undefined}
 */
function firstString(value, key) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const entry = value[key];
  if (typeof entry === "string" && entry.length > 0 && entry !== "[redacted]") return entry;
  if (typeof entry === "number" && Number.isFinite(entry)) return String(entry);
  for (const nested of Object.values(value)) {
    const found = firstString(nested, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const block = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = block && typeof block === "object" && "text" in block ? String(block.text) : "";
  for (const secret of secrets) {
    if (secret.length >= 8 && text.includes(secret)) {
      throw new Error("secret leaked into tool output");
    }
  }
  /** @type {Record<string, unknown> | null} */
  let json = null;
  try {
    const parsed = JSON.parse(text);
    json = isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    json = null;
  }
  if (result.isError === true && process.env["LIVE_DEBUG"] === "1") {
    writeLine(
      `  ERR ${name}/${String(args["action"])}: ${text.replace(/\s+/g, " ").slice(0, 300)}`,
    );
  }
  return { isError: result.isError === true, text, json };
}

/**
 * @param {{ isError: boolean, text: string }} result
 */
function cleanMiss(result) {
  if (!result.isError) return false;
  if (/Server\.js|\.js:\d|stack trace|\/tmp\/|\/var\//i.test(result.text)) return false;
  return result.text.includes("[not-found]") || /not found|does not exist/i.test(result.text);
}

/**
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {string} name
 * @param {string} tool
 * @param {Record<string, unknown>} args
 */
async function readOk(client, name, tool, args) {
  const result = await call(client, tool, args);
  const leaked = secrets.some((secret) => secret.length >= 8 && result.text.includes(secret));
  record(name, !result.isError && !leaked && !/stack trace|\.php:\d/i.test(result.text));
  return result;
}

function hasAuth() {
  if (accessToken.trim().length >= 8) return true;
  return (
    clientId.trim().length >= 8 &&
    clientSecret.trim().length >= 8 &&
    username.trim().length > 0 &&
    password.trim().length > 0
  );
}

async function main() {
  if (baseUrl.trim().length === 0 || !hasAuth()) {
    writeLine(
      "SKIP  live-check  WALLABAG_BASE_URL and either WALLABAG_ACCESS_TOKEN or password-grant env are unset.",
    );
    return;
  }

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: root,
    env: {
      ...process.env,
      WALLABAG_BASE_URL: baseUrl,
      WALLABAG_ALLOW_WRITES: allowWrites ? "true" : "false",
      WALLABAG_TOOLSETS: "all",
      WALLABAG_CACHE_TTL_SEC: "0",
      WALLABAG_PER_MINUTE: "300",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "wallabag-live-check", version: "0" });
  await client.connect(transport);

  const stamp = Date.now().toString(36);
  /** @type {string | undefined} */
  let entryId;
  /** @type {string | undefined} */
  let annotationId;

  try {
    const listed = await client.listTools();
    record("lists tools", Array.isArray(listed.tools) && listed.tools.length >= 6);

    await readOk(client, "info", "wallabag_info", { action: "get" });
    await readOk(client, "version", "wallabag_info", { action: "get_version" });
    await readOk(client, "config", "wallabag_config", { action: "get" });
    const me = await readOk(client, "user", "wallabag_user", { action: "get" });
    record(
      "user redacts secrets",
      firstString(me.json, "password") === undefined &&
        firstString(me.json, "client_secret") === undefined &&
        !secrets.some((secret) => secret.length >= 8 && me.text.includes(secret)),
    );
    await readOk(client, "tags", "wallabag_tags", { action: "get" });
    await readOk(client, "entries", "wallabag_entries", {
      action: "get",
      query: { perPage: "5", detail: "metadata" },
    });
    await readOk(client, "search", "wallabag_search", {
      action: "get",
      query: { term: "a", perPage: "5" },
    });

    const missing = await call(client, "wallabag_entries", {
      action: "get_by_id",
      params: { entry: "0" },
    });
    record("entry unknown id", cleanMiss(missing) || (!missing.isError && !missing.text.includes("[")));

    const sampleUrl = `https://example.com/mcp-live-check-${stamp}`;
    const preview = await call(client, "wallabag_entries", {
      action: "post",
      body: { url: sampleUrl, title: `mcp-live-${stamp}` },
    });
    record(
      "entry create preview",
      preview.json?.["dry_run"] === true && preview.json?.["executed"] === false,
    );

    if (allowWrites) {
      const created = await call(client, "wallabag_entries", {
        action: "post",
        body: { url: sampleUrl, title: `mcp-live-${stamp}` },
        confirm: true,
      });
      entryId = firstString(created.json, "id");
      record("entry create", !created.isError && entryId !== undefined);

      if (entryId !== undefined) {
        const tagPreview = await call(client, "wallabag_entries", {
          action: "post_tags",
          params: { entry: entryId },
          body: { tags: "mcp-live" },
        });
        record(
          "tag preview",
          tagPreview.json?.["dry_run"] === true && tagPreview.json?.["executed"] === false,
        );
        const tagged = await call(client, "wallabag_entries", {
          action: "post_tags",
          params: { entry: entryId },
          body: { tags: "mcp-live" },
          confirm: true,
        });
        record("tag", !tagged.isError);

        const notePreview = await call(client, "wallabag_annotations", {
          action: "post_by_id",
          params: { entry: entryId },
          body: { text: "mcp live-check note" },
        });
        record(
          "annotate preview",
          notePreview.json?.["dry_run"] === true && notePreview.json?.["executed"] === false,
        );
        const noted = await call(client, "wallabag_annotations", {
          action: "post_by_id",
          params: { entry: entryId },
          body: { text: "mcp live-check note" },
          confirm: true,
        });
        annotationId = firstString(noted.json, "id");
        record("annotate", !noted.isError);
      } else {
        record("tag preview", false);
        record("tag", false);
        record("annotate preview", false);
        record("annotate", false);
      }
    } else {
      record("entry create skipped without WALLABAG_ALLOW_WRITES", true);
    }
  } finally {
    if (allowWrites && annotationId !== undefined) {
      const removed = await call(client, "wallabag_annotations", {
        action: "delete_by_id",
        params: { annotation: annotationId },
        confirm: true,
      }).catch(() => undefined);
      record("annotation delete", removed !== undefined && !removed.isError);
    }
    if (allowWrites && entryId !== undefined) {
      const removed = await call(client, "wallabag_entries", {
        action: "delete_by_id",
        params: { entry: entryId },
        confirm: true,
      }).catch(() => undefined);
      record("entry delete", removed !== undefined && !removed.isError);
    }
    await client.close();
    await transport.close();
  }

  if (failed > 0) {
    writeLine(`FAIL  live-check  passed=${passed} failed=${failed}`);
    process.exit(1);
  }
  writeLine(`PASS  live-check  passed=${passed} failed=0`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "live-check failed";
  writeLine(`FAIL  live-check  ${redact(message).slice(0, 180)}`);
  process.exit(1);
});
