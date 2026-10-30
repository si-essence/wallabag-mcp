import { z } from "zod";
import { brandBaseUrl, brandSecret, type BaseUrl, type Secret } from "./brand.js";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "./constants.js";
import { ConnectorError } from "./errors.js";
import { parseToolsets } from "./operations.js";
import { fixedError } from "./zod-messages.js";

const invalid = fixedError("invalid");

const EnvSchema = z.object({
  WALLABAG_BASE_URL: z.url({ error: invalid }),
  WALLABAG_CLIENT_ID: z
    .string({ error: invalid })
    .trim()
    .min(8, { error: invalid })
    .max(512, { error: invalid })
    .optional(),
  WALLABAG_CLIENT_SECRET: z
    .string({ error: invalid })
    .trim()
    .min(8, { error: invalid })
    .max(512, { error: invalid })
    .optional(),
  WALLABAG_USERNAME: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(120, { error: invalid })
    .optional(),
  WALLABAG_PASSWORD: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(512, { error: invalid })
    .optional(),
  WALLABAG_ACCESS_TOKEN: z
    .string({ error: invalid })
    .trim()
    .min(8, { error: invalid })
    .max(2048, { error: invalid })
    .optional(),
  WALLABAG_ALLOW_WRITES: z.string({ error: invalid }).optional(),
  WALLABAG_TOOLSETS: z.string({ error: invalid }).optional(),
  WALLABAG_PER_MINUTE: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  WALLABAG_TIMEOUT_MS: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  WALLABAG_CONTACT: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(120, { error: invalid })
    .optional(),
  MCP_TRANSPORT: z.enum(["stdio", "http"], { error: invalid }).optional(),
  PORT: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  WALLABAG_CACHE_TTL_SEC: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
});

export interface PasswordGrantConfig {
  clientId: Secret;
  clientSecret: Secret;
  username: string;
  password: Secret;
}

export interface Config {
  baseUrl: BaseUrl;
  accessToken: Secret | undefined;
  password: PasswordGrantConfig | undefined;
  allowWrites: boolean;
  toolsets: readonly string[];
  perMinute: number;
  timeoutMs: number;
  contact: string;
  transport: "stdio" | "http";
  port: number;
  cacheTtlSec: number;
  userAgent: string;
}

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return blank(env[name]);
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path =
        issue.path.length === 0 ? "(root)" : issue.path.map((part) => String(part)).join(".");
      return `${path} (${issue.code})`;
    })
    .join("; ");
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (raw === undefined) return fallback;
  const parsed = z.number().int().min(min).max(max).safeParse(Number(raw));
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${field} (out_of_range).`);
  }
  return parsed.data;
}

function userAgentFor(contact: string): string {
  const clean = contact
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 120);
  return `${CONNECTOR_NAME}/${CONNECTOR_VERSION} (${clean.length > 0 ? clean : "contact@example.com"})`;
}

function normalizeBaseUrl(value: string): BaseUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError("config", "Invalid environment: WALLABAG_BASE_URL (invalid_url).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectorError("config", "Invalid environment: WALLABAG_BASE_URL (invalid_url).");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConnectorError("config", "Invalid environment: WALLABAG_BASE_URL (userinfo).");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConnectorError("config", "Invalid environment: WALLABAG_BASE_URL (query_or_hash).");
  }
  return brandBaseUrl(value.replace(/\/+$/, ""));
}

function rejectSecretIn(value: string, secrets: readonly string[], field: string): void {
  for (const secret of secrets) {
    if (secret.length >= 8 && value.includes(secret)) {
      throw new ConnectorError("config", `Invalid environment: ${field} (contains_secret).`);
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): Config {
  const urlRaw = read(env, "WALLABAG_BASE_URL");
  if (urlRaw === undefined) {
    throw new ConnectorError(
      "config",
      "Invalid environment: WALLABAG_BASE_URL (required). Set it to your Wallabag origin, for example http://127.0.0.1:80.",
    );
  }

  const parsed = EnvSchema.safeParse({
    WALLABAG_BASE_URL: urlRaw,
    WALLABAG_CLIENT_ID: read(env, "WALLABAG_CLIENT_ID"),
    WALLABAG_CLIENT_SECRET: read(env, "WALLABAG_CLIENT_SECRET"),
    WALLABAG_USERNAME: read(env, "WALLABAG_USERNAME"),
    WALLABAG_PASSWORD: read(env, "WALLABAG_PASSWORD"),
    WALLABAG_ACCESS_TOKEN: read(env, "WALLABAG_ACCESS_TOKEN"),
    WALLABAG_ALLOW_WRITES: read(env, "WALLABAG_ALLOW_WRITES"),
    WALLABAG_TOOLSETS: read(env, "WALLABAG_TOOLSETS"),
    WALLABAG_PER_MINUTE: read(env, "WALLABAG_PER_MINUTE"),
    WALLABAG_TIMEOUT_MS: read(env, "WALLABAG_TIMEOUT_MS"),
    WALLABAG_CONTACT: read(env, "WALLABAG_CONTACT"),
    MCP_TRANSPORT: read(env, "MCP_TRANSPORT"),
    PORT: read(env, "PORT"),
    WALLABAG_CACHE_TTL_SEC: read(env, "WALLABAG_CACHE_TTL_SEC"),
  });
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${issueSummary(parsed.error)}.`);
  }

  const data = parsed.data;
  const accessToken =
    data.WALLABAG_ACCESS_TOKEN === undefined ? undefined : brandSecret(data.WALLABAG_ACCESS_TOKEN);
  const grantParts = [
    data.WALLABAG_CLIENT_ID,
    data.WALLABAG_CLIENT_SECRET,
    data.WALLABAG_USERNAME,
    data.WALLABAG_PASSWORD,
  ];
  const grantSet = grantParts.filter((part) => part !== undefined);
  let password: PasswordGrantConfig | undefined;
  if (grantSet.length === 4) {
    password = {
      clientId: brandSecret(data.WALLABAG_CLIENT_ID ?? ""),
      clientSecret: brandSecret(data.WALLABAG_CLIENT_SECRET ?? ""),
      username: data.WALLABAG_USERNAME ?? "",
      password: brandSecret(data.WALLABAG_PASSWORD ?? ""),
    };
  } else if (grantSet.length > 0) {
    throw new ConnectorError(
      "config",
      "Invalid environment: password grant needs WALLABAG_CLIENT_ID, WALLABAG_CLIENT_SECRET, WALLABAG_USERNAME, and WALLABAG_PASSWORD together.",
    );
  }
  if (accessToken === undefined && password === undefined) {
    throw new ConnectorError(
      "config",
      "Invalid environment: set WALLABAG_ACCESS_TOKEN or the password-grant variables WALLABAG_CLIENT_ID, WALLABAG_CLIENT_SECRET, WALLABAG_USERNAME, and WALLABAG_PASSWORD.",
    );
  }

  const baseUrl = normalizeBaseUrl(data.WALLABAG_BASE_URL);
  const contact = data.WALLABAG_CONTACT ?? "contact@example.com";
  if (hasControlChar(contact)) {
    throw new ConnectorError("config", "Invalid environment: WALLABAG_CONTACT (control_character).");
  }
  const userAgent = userAgentFor(contact);
  const secrets = [
    accessToken,
    password?.clientId,
    password?.clientSecret,
    password?.password,
  ].filter((item): item is Secret => item !== undefined);
  rejectSecretIn(baseUrl, secrets, "WALLABAG_BASE_URL");
  rejectSecretIn(contact, secrets, "WALLABAG_CONTACT");
  rejectSecretIn(userAgent, secrets, "WALLABAG_CONTACT");

  const transport = argv.includes("--http") ? "http" : (data.MCP_TRANSPORT ?? "stdio");
  return {
    baseUrl,
    accessToken,
    password,
    allowWrites: data.WALLABAG_ALLOW_WRITES === "true",
    toolsets: parseToolsets(data.WALLABAG_TOOLSETS),
    perMinute: boundedInt(data.WALLABAG_PER_MINUTE, 30, 1, 300, "WALLABAG_PER_MINUTE"),
    timeoutMs: boundedInt(data.WALLABAG_TIMEOUT_MS, 20_000, 1000, 120_000, "WALLABAG_TIMEOUT_MS"),
    contact,
    transport,
    port: boundedInt(data.PORT, 3000, 1, 65535, "PORT"),
    cacheTtlSec: boundedInt(data.WALLABAG_CACHE_TTL_SEC, 60, 0, 3600, "WALLABAG_CACHE_TTL_SEC"),
    userAgent,
  };
}
