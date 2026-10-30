import { z } from "zod";
import { API_PREFIX } from "./constants.js";
import { ConnectorError } from "./errors.js";
import type { QueryMap, QueryValue } from "./http.js";

export const jsonObjectSchema = z.record(z.string(), z.unknown());
export const jsonValueSchema = z.unknown();

export function definedQuery(
  record: Readonly<Record<string, QueryValue | undefined>>,
): QueryMap | undefined {
  const out: Record<string, QueryValue> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export function fillExpressPath(
  expressPath: string,
  params: Readonly<Record<string, string | number>>,
): string {
  if (!expressPath.startsWith("/")) {
    throw new ConnectorError("input", "Request path must start with /.");
  }
  const parts = expressPath.split("/").filter((part) => part.length > 0);
  const out: string[] = [];
  for (const part of parts) {
    const match = /^:([A-Za-z0-9_]+)(\?)?$/.exec(part);
    if (match === null) {
      out.push(part);
      continue;
    }
    const name = match[1];
    if (name === undefined) {
      throw new ConnectorError("input", "Request path still contains a template marker.");
    }
    const optional = match[2] === "?";
    const value = params[name];
    if (value === undefined || value === "") {
      if (optional) continue;
      throw new ConnectorError("input", `Missing path parameter ${name}.`);
    }
    out.push(encodeURIComponent(String(value)));
  }
  const relative = out.join("/");
  if (relative.includes(":") || relative.includes("?")) {
    throw new ConnectorError("input", "Request path still contains a template marker.");
  }
  if (API_PREFIX.length === 0) return relative;
  return [API_PREFIX, relative].filter((part) => part.length > 0).join("/");
}
