#!/usr/bin/env node
/**
 * Generate src/operations.ts from vendor/routes.json (Wallabag 2.6.15 MIT route snapshot).
 * Run: node scripts/gen-operations.mjs
 *
 * GET is a read. POST, PUT, PATCH, and DELETE are writes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = join(root, "vendor", "routes.json");

export const DEFAULT_TOOLSETS = ["entries", "tags", "annotations", "search", "config", "info"];

export const READ_POST_PATHS = [];

export const GET_SIDE_EFFECT_PATHS = [];

const EXCLUSION_TABLE = [
  {
    method: "GET",
    path: "/api/entries/:entry/export",
    reason: "Entry export returns a downloadable file (epub, pdf, mobi, txt, csv), not the JSON entry payload.",
  },
  {
    method: "GET",
    path: "/developer",
    reason: "HTML developer portal that lists OAuth clients. The connector uses the JSON REST API only.",
  },
  {
    method: "GET",
    path: "/developer/client/create",
    reason: "HTML form to create an OAuth client. Create a client in the Wallabag UI, then set env vars.",
  },
  {
    method: "POST",
    path: "/developer/client/create",
    reason: "HTML form post that creates an OAuth client. Not a JSON REST endpoint.",
  },
  {
    method: "POST",
    path: "/developer/client/delete/:id",
    reason: "HTML form post with a CSRF token that deletes an OAuth client. Not a JSON REST endpoint.",
  },
  {
    method: "GET",
    path: "/developer/howto/first-app",
    reason: "HTML how-to page for first-party apps. Not a JSON REST endpoint.",
  },
];

const TOOLSET_BY_SEGMENT = {
  entries: "entries",
  tag: "tags",
  tags: "tags",
  taggingrule: "config",
  annotations: "annotations",
  search: "search",
  user: "user",
  config: "config",
  version: "info",
  info: "info",
};

const QUERY_HINTS = [
  {
    test: /\/entries\/exists$/,
    methods: ["GET"],
    names: ["url", "urls", "hashed_url", "hashed_urls", "return_id"],
  },
  {
    test: /\/entries$/,
    methods: ["GET"],
    names: [
      "archive",
      "starred",
      "sort",
      "order",
      "page",
      "perPage",
      "tags",
      "since",
      "public",
      "detail",
      "domain_name",
      "annotations",
    ],
  },
  { test: /\/entries\/:entry$/, methods: ["DELETE"], names: ["expect"] },
  { test: /\/entries\/list$/, methods: ["DELETE"], names: ["urls"] },
  { test: /\/entries\/lists$/, methods: ["POST"], names: ["urls"] },
  { test: /\/entries\/tags\/list$/, methods: ["DELETE"], names: ["list"] },
  { test: /\/entries\/tags\/lists$/, methods: ["POST"], names: ["list"] },
  { test: /\/search$/, methods: ["GET"], names: ["term", "page", "perPage"] },
  { test: /\/tag\/label$/, methods: ["DELETE"], names: ["tag"] },
  { test: /\/tags\/label$/, methods: ["DELETE"], names: ["tags"] },
];

const BODY_HINTS = {
  "POST /api/entries": {
    fields: [
      { name: "url", type: "string", required: true },
      { name: "title", type: "string", required: false },
      { name: "tags", type: "string", required: false },
      { name: "archive", type: "integer", required: false },
      { name: "starred", type: "integer", required: false },
      { name: "public", type: "integer", required: false },
      { name: "content", type: "string", required: false },
      { name: "language", type: "string", required: false },
      { name: "preview_picture", type: "string", required: false },
      { name: "published_at", type: "string", required: false },
      { name: "authors", type: "string", required: false },
      { name: "origin_url", type: "string", required: false },
    ],
    sample: { url: "https://example.com/article" },
  },
  "PATCH /api/entries/:entry": {
    fields: [
      { name: "title", type: "string", required: false },
      { name: "tags", type: "string", required: false },
      { name: "archive", type: "integer", required: false },
      { name: "starred", type: "integer", required: false },
      { name: "public", type: "integer", required: false },
      { name: "content", type: "string", required: false },
      { name: "language", type: "string", required: false },
      { name: "preview_picture", type: "string", required: false },
      { name: "published_at", type: "string", required: false },
      { name: "authors", type: "string", required: false },
      { name: "origin_url", type: "string", required: false },
    ],
    sample: { archive: 1 },
  },
  "POST /api/entries/:entry/tags": {
    fields: [{ name: "tags", type: "string", required: true }],
    sample: { tags: "mcp,sample" },
  },
  "POST /api/annotations/:entry": {
    fields: [
      { name: "text", type: "string", required: true },
      { name: "quote", type: "string", required: false },
      { name: "ranges", type: "array", required: false },
    ],
    sample: { text: "sample note", quote: "sample quote" },
  },
  "PUT /api/annotations/:annotation": {
    fields: [{ name: "text", type: "string", required: true }],
    sample: { text: "updated note" },
  },
  "PUT /api/user": {
    fields: [
      { name: "username", type: "string", required: true },
      { name: "password", type: "string", required: true },
      { name: "email", type: "string", required: true },
      { name: "client_name", type: "string", required: false },
    ],
    sample: {
      username: "sample-user",
      password: "sample-password-value",
      email: "user@example.com",
      client_name: "mcp",
    },
  },
};

/**
 * @param {string} value
 */
export function slug(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

/**
 * @param {string} path
 */
export function toolsetForPath(path) {
  const parts = path.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const first = (parts[0] ?? "info").replace(/^:/, "");
  return TOOLSET_BY_SEGMENT[first] ?? "info";
}

/**
 * @param {string} method
 * @param {string} path
 * @param {string} toolset
 */
export function actionFrom(method, path, toolset) {
  const parts = path.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const first = parts[0] ?? "";
  if (slug(first) === toolset) parts.shift();
  const statics = parts.filter((part) => !part.startsWith(":")).map((part) => slug(part));
  const verb = method.toLowerCase();
  const name = [verb, ...statics].filter(Boolean).join("_");
  if (name.length === 0) return verb;
  if (name === verb && parts.some((part) => part.startsWith(":"))) return `${verb}_by_id`;
  if (name === verb) return verb;
  return name;
}

/**
 * @param {string} method
 * @param {string} path
 */
export function classifyWrite(method, path) {
  if (method === "GET") return GET_SIDE_EFFECT_PATHS.includes(path);
  if (method === "POST" && READ_POST_PATHS.includes(path)) return false;
  return true;
}

/**
 * @param {string} path
 */
function pathParamsOf(path) {
  /** @type {{ name: string, required: boolean }[]} */
  const out = [];
  for (const match of path.matchAll(/:([A-Za-z0-9_]+)(\?)?/g)) {
    const name = match[1];
    if (name === undefined) continue;
    out.push({ name, required: match[2] !== "?" });
  }
  return out;
}

/**
 * @param {string} name
 */
function sampleForParam(name) {
  const lower = name.toLowerCase();
  if (lower.includes("email")) return "user@example.com";
  if (lower.includes("page")) return "1";
  if (lower === "entry" || lower === "annotation" || lower === "tag" || lower === "id") {
    return "1";
  }
  return "sample";
}

/**
 * @param {string} path
 * @param {string} method
 */
function queryFieldsFor(path, method) {
  /** @type {{ name: string, type: string, required: boolean, in: "query" }[]} */
  const fields = [];
  const seen = new Set();
  for (const hint of QUERY_HINTS) {
    if (!hint.test.test(path)) continue;
    if (!hint.methods.includes(method)) continue;
    for (const name of hint.names) {
      if (seen.has(name)) continue;
      seen.add(name);
      fields.push({ name, type: "string", required: false, in: "query" });
    }
  }
  return fields;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {boolean} write
 */
function warningsFor(method, path, write) {
  if (!write) return [];
  const lower = path.toLowerCase();
  /** @type {string[]} */
  const out = [];
  if (method === "DELETE") {
    out.push("This deletes data on the Wallabag server. It may be irreversible.");
  }
  if (path === "/api/user" && method === "PUT") {
    out.push("This registers a new Wallabag user and OAuth client when the server allows it.");
  }
  if (/\/reload$/.test(lower)) {
    out.push("This refetches the article content from the origin URL.");
  }
  if (/\/entries\/lists$|\/entries\/list$|\/tags\/lists$|\/tags\/list$/.test(lower)) {
    out.push("This is a bulk action across many URLs.");
  }
  return [...new Set(out)];
}

/**
 * @param {string} method
 * @param {string} path
 * @param {readonly string[]} warnings
 */
function isDestructive(method, path, warnings) {
  if (method === "DELETE") return true;
  if (path === "/api/user" && method === "PUT") return true;
  return warnings.some((line) => /deletes|registers a new/.test(line));
}

/**
 * @param {string} handler
 * @param {string} method
 * @param {string} path
 */
function schemaIdFor(handler, method, path) {
  if (handler.includes("getEntriesExists")) return "exists";
  if (handler.includes("getEntriesAction") || handler.includes("getSearchAction")) return "entryList";
  if (handler.includes("getEntriesTags")) return "tagList";
  if (handler.includes("getTagsAction")) return "tagList";
  if (handler.includes("deleteTag") || handler.includes("deleteTags")) return "tag";
  if (handler.includes("getAnnotations")) return "annotationList";
  if (handler.includes("Annotation")) return "annotation";
  if (handler.includes("getConfig")) return "config";
  if (handler.includes("getTaggingrule")) return "taggingRules";
  if (handler.includes("putUserAction")) return "userCreated";
  if (handler.includes("getUserAction") || handler.includes("UserRest")) return "user";
  if (handler.includes("getVersion")) return "version";
  if (handler.includes("getInfo")) return "info";
  if (handler.includes("EntryRest") || path.includes("/entries")) return "entry";
  if (method === "DELETE") return "ok";
  return "jsonEnvelope";
}

/**
 * @param {unknown} raw
 */
export function parseSnapshot(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("vendor/routes.json must be an object.");
  }
  const routes = raw["routes"];
  if (!Array.isArray(routes)) throw new Error("vendor/routes.json is missing routes.");
  /** @type {{ method: string, path: string, handler: string, name: string }[]} */
  const rows = [];
  for (const item of routes) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Each route must be an object.");
    }
    const method = String(item["method"] ?? "").toUpperCase();
    const path = String(item["path"] ?? "");
    const handler = String(item["handler"] ?? "");
    const name = String(item["name"] ?? "");
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw new Error(`Unsupported method: ${method}`);
    }
    if (!path.startsWith("/")) throw new Error(`Path must start with /: ${path}`);
    rows.push({ method, path, handler, name });
  }
  return rows;
}

/**
 * @param {string} source
 */
export function planOperations(source) {
  const snapshot = JSON.parse(source);
  const routerRows = parseSnapshot(snapshot);
  const routerKeys = routerRows.map((row) => `${row.method} ${row.path}`);
  const routerSet = new Set(routerKeys);
  if (new Set(routerKeys).size !== routerKeys.length) {
    throw new Error("vendor/routes.json has duplicate method+path rows.");
  }

  for (const path of READ_POST_PATHS) {
    if (!routerSet.has(`POST ${path}`)) throw new Error(`READ_POST path is not a POST: ${path}`);
  }
  for (const path of GET_SIDE_EFFECT_PATHS) {
    if (!routerSet.has(`GET ${path}`)) throw new Error(`GET side-effect path missing: ${path}`);
  }

  const exclusionKeys = new Set();
  for (const row of EXCLUSION_TABLE) {
    const key = `${row.method} ${row.path}`;
    if (!routerSet.has(key)) throw new Error(`Exclusion is not in the snapshot: ${key}`);
    if (row.reason.trim().length < 20) throw new Error(`Exclusion reason too short: ${key}`);
    exclusionKeys.add(key);
  }

  /** @type {object[]} */
  const rows = [];
  const seen = new Map();

  for (const route of routerRows) {
    const key = `${route.method} ${route.path}`;
    const excluded = EXCLUSION_TABLE.find(
      (row) => row.method === route.method && row.path === route.path,
    );
    if (excluded !== undefined) continue;

    const toolset = toolsetForPath(route.path);
    let action = actionFrom(route.method, route.path, toolset);
    if (action === "help") action = `${action}_op`;
    let unique = `${toolset}::${action}`;
    if (seen.has(unique)) {
      const params = pathParamsOf(route.path).map((param) => slug(param.name));
      const withParams =
        params.length > 0 ? `${action}_${params.join("_")}` : `${action}_${route.method.toLowerCase()}`;
      action = seen.has(`${toolset}::${withParams}`) ? `${withParams}_${rows.length}` : withParams;
      unique = `${toolset}::${action}`;
    }
    seen.set(unique, key);

    const pathParams = pathParamsOf(route.path);
    /** @type {Record<string, string>} */
    const sampleParams = {};
    /** @type {{ name: string, type: string, required: boolean, in: string }[]} */
    const fields = [];
    for (const param of pathParams) {
      if (param.required) sampleParams[param.name] = sampleForParam(param.name);
      fields.push({ name: param.name, type: "string", required: param.required, in: "path" });
    }
    const queryFields = queryFieldsFor(route.path, route.method);
    fields.push(...queryFields);
    /** @type {Record<string, string>} */
    const sampleQuery = {};
    for (const field of queryFields) {
      if (field.required) sampleQuery[field.name] = sampleForParam(field.name);
    }

    const write = classifyWrite(route.method, route.path);
    const warnings = warningsFor(route.method, route.path, write);
    const bodyHint = BODY_HINTS[key];
    const bodyFields = bodyHint?.fields ?? [];
    const sampleBody = bodyHint?.sample;
    const summary = `${route.method} ${route.path}`.slice(0, 240);
    const schemaId = schemaIdFor(route.handler, route.method, route.path);
    const revealSecret = route.handler === "UserRestController.putUserAction";

    rows.push({
      method: route.method,
      path: route.path,
      operationId: key,
      action,
      tool: `wallabag_${toolset}`,
      toolset,
      tag: toolset,
      handler: route.handler,
      write,
      destructive: isDestructive(route.method, route.path, warnings),
      revealSecret,
      kind: "json",
      schemaId,
      summary,
      pathParams: pathParams.map((param) => param.name),
      queryParams: queryFields.map((field) => field.name),
      fields,
      bodyFields,
      warnings,
      sampleParams,
      sampleQuery,
      sampleBody,
    });
  }

  rows.sort((a, b) => {
    const tool = a.tool.localeCompare(b.tool);
    if (tool !== 0) return tool;
    return a.action.localeCompare(b.action);
  });
  const exclusions = [...EXCLUSION_TABLE].sort((a, b) =>
    `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
  );

  if (rows.length + exclusions.length !== routerRows.length) {
    throw new Error(
      `Coverage mismatch: ${rows.length} ops + ${exclusions.length} exclusions !== ${routerRows.length} snapshot rows.`,
    );
  }

  const toolsets = [...new Set(rows.map((row) => row.toolset))].sort();
  /** @type {Record<string, { operations: number, tags: string[] }>} */
  const counts = {};
  for (const toolset of toolsets) {
    const subset = rows.filter((row) => row.toolset === toolset);
    counts[toolset] = {
      operations: subset.length,
      tags: [...new Set(subset.map((row) => row.tag))].sort(),
    };
  }
  for (const name of DEFAULT_TOOLSETS) {
    if (!toolsets.includes(name)) throw new Error(`Default toolset has no operations: ${name}`);
  }
  return { rows, exclusions, counts, toolsets, routerRows };
}

/**
 * @param {unknown} value
 */
function ts(value) {
  return JSON.stringify(value);
}

/**
 * @param {object} row
 */
function emitRow(row) {
  const options = [
    `action: ${ts(row.action)}`,
    `toolset: ${ts(row.toolset)}`,
    `tag: ${ts(row.tag)}`,
    `handler: ${ts(row.handler)}`,
    `operationId: ${ts(row.operationId)}`,
    `write: ${row.write}`,
    `destructive: ${row.destructive}`,
    `revealSecret: ${row.revealSecret}`,
    `kind: ${ts(row.kind)}`,
    `schemaId: ${ts(row.schemaId)}`,
    `summary: ${ts(row.summary)}`,
    `pathParams: ${ts(row.pathParams)}`,
    `queryParams: ${ts(row.queryParams)}`,
    `fields: ${ts(row.fields)}`,
    `bodyFields: ${ts(row.bodyFields)}`,
    `warnings: ${ts(row.warnings)}`,
    `sampleParams: ${ts(row.sampleParams)}`,
    `sampleQuery: ${ts(row.sampleQuery)}`,
  ];
  if (row.sampleBody !== undefined) options.push(`sampleBody: ${ts(row.sampleBody)}`);
  return `  row(${ts(row.method)}, ${ts(row.path)}, ${ts(row.tool)}, {\n    ${options.join(",\n    ")},\n  })`;
}

function emitFile(plan) {
  return `/** Generated by scripts/gen-operations.mjs from vendor/routes.json. Do not edit by hand. */

import { ConnectorError } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ResponseKind = "json" | "empty";
export type SchemaId =
  | "jsonEnvelope"
  | "ok"
  | "entry"
  | "entryList"
  | "exists"
  | "tag"
  | "tagList"
  | "annotation"
  | "annotationList"
  | "config"
  | "taggingRules"
  | "user"
  | "userCreated"
  | "info"
  | "version";

export interface FieldSchema {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly in?: "path" | "query";
}

export interface Operation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly tool: string;
  readonly action: string;
  readonly toolset: string;
  readonly tag: string;
  readonly handler: string;
  readonly operationId: string;
  readonly write: boolean;
  readonly destructive: boolean;
  readonly revealSecret: boolean;
  readonly kind: ResponseKind;
  readonly schemaId: SchemaId;
  readonly summary: string;
  readonly pathParams: readonly string[];
  readonly queryParams: readonly string[];
  readonly fields: readonly FieldSchema[];
  readonly bodyFields: readonly FieldSchema[];
  readonly warnings: readonly string[];
  readonly sampleParams: Readonly<Record<string, string>>;
  readonly sampleQuery: Readonly<Record<string, string>>;
  readonly sampleBody?: unknown;
}

export interface ExcludedOperation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly reason: string;
}

function row(
  method: HttpMethod,
  path: string,
  tool: string,
  options: {
    action: string;
    toolset: string;
    tag: string;
    handler: string;
    operationId: string;
    write: boolean;
    destructive: boolean;
    revealSecret: boolean;
    kind: ResponseKind;
    schemaId: SchemaId;
    summary: string;
    pathParams: readonly string[];
    queryParams: readonly string[];
    fields: readonly FieldSchema[];
    bodyFields: readonly FieldSchema[];
    warnings: readonly string[];
    sampleParams: Readonly<Record<string, string>>;
    sampleQuery: Readonly<Record<string, string>>;
    sampleBody?: unknown;
  },
): Operation {
  return {
    method,
    path,
    tool,
    action: options.action,
    toolset: options.toolset,
    tag: options.tag,
    handler: options.handler,
    operationId: options.operationId,
    write: options.write,
    destructive: options.destructive,
    revealSecret: options.revealSecret,
    kind: options.kind,
    schemaId: options.schemaId,
    summary: options.summary,
    pathParams: options.pathParams,
    queryParams: options.queryParams,
    fields: options.fields,
    bodyFields: options.bodyFields,
    warnings: options.warnings,
    sampleParams: options.sampleParams,
    sampleQuery: options.sampleQuery,
    ...(options.sampleBody !== undefined ? { sampleBody: options.sampleBody } : {}),
  };
}

export const DEFAULT_TOOLSETS = ${ts(DEFAULT_TOOLSETS)} as const;

export const ALL_TOOLSETS = ${ts(plan.toolsets)} as const;

export const READ_POST_PATHS = ${ts(READ_POST_PATHS)} as const;

export const GET_SIDE_EFFECT_PATHS = ${ts(GET_SIDE_EFFECT_PATHS)} as const;

export const TOOLSET_COUNTS: Readonly<
  Record<string, { readonly operations: number; readonly tags: readonly string[] }>
> = ${ts(plan.counts)};

export const EXCLUSIONS: readonly ExcludedOperation[] = ${ts(plan.exclusions)};

export const OPERATIONS: readonly Operation[] = [
${plan.rows.map((row) => emitRow(row)).join(",\n")},
];

export function toolNames(): string[] {
  return [...new Set(OPERATIONS.map((operation) => operation.tool))].sort();
}

export function operationsForTool(name: string): Operation[] {
  return OPERATIONS.filter((operation) => operation.tool === name);
}

export function toolIsWrite(name: string): boolean {
  return OPERATIONS.some((operation) => operation.tool === name && operation.write);
}

export function routerKeys(): string[] {
  return OPERATIONS.map((operation) => \`\${operation.method} \${operation.path}\`).sort();
}

export function requireOp(tool: string, action: string): Operation {
  const found = OPERATIONS.find((operation) => operation.tool === tool && operation.action === action);
  if (found === undefined) {
    throw new ConnectorError("input", \`Unknown Wallabag operation \${tool} \${action}.\`);
  }
  return found;
}

export function parseToolsets(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_TOOLSETS];
  const trimmed = raw.trim();
  if (trimmed === "all") return [...ALL_TOOLSETS];
  const wanted = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const allowed = new Set<string>(ALL_TOOLSETS);
  const unknown = wanted.filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new ConnectorError("config", "Unknown WALLABAG_TOOLSETS value.");
  }
  return [...new Set(wanted)];
}

export function toolsForToolsets(enabled: readonly string[]): string[] {
  const allow = new Set(enabled);
  return toolNames().filter((name) => {
    const operation = OPERATIONS.find((row) => row.tool === name);
    return operation !== undefined && allow.has(operation.toolset);
  });
}
`;
}

function main() {
  const source = readFileSync(snapshotPath, "utf8");
  const plan = planOperations(source);
  writeFileSync(join(root, "src", "operations.ts"), emitFile(plan));
  process.stderr.write(
    `wrote ${plan.rows.length} operations, ${plan.exclusions.length} exclusions, ${plan.toolsets.length} toolsets\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
