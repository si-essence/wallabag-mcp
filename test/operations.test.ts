import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALL_TOOLSETS,
  DEFAULT_TOOLSETS,
  EXCLUSIONS,
  OPERATIONS,
  parseToolsets,
  toolNames,
} from "../src/operations.js";

function planned(): { actions: string[]; exclusions: string[]; router: string[] } {
  const script = [
    'import { planOperations } from "./scripts/gen-operations.mjs";',
    'import { readFileSync } from "node:fs";',
    'const source = readFileSync("./vendor/routes.json", "utf8");',
    "const plan = planOperations(source);",
    "process.stdout.write(JSON.stringify({",
    '  actions: plan.rows.map((row) => row.tool + ":" + row.action),',
    '  exclusions: plan.exclusions.map((row) => row.method + " " + row.path),',
    '  router: plan.routerRows.map((row) => row.method + " " + row.path),',
    "}));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "generator failed");
  }
  return JSON.parse(result.stdout) as { actions: string[]; exclusions: string[]; router: string[] };
}

describe("Wallabag route snapshot coverage", () => {
  const generated = planned();
  const registry = OPERATIONS.map((operation) => `${operation.method} ${operation.path}`);
  const excluded = EXCLUSIONS.map((operation) => `${operation.method} ${operation.path}`);

  it("matches the snapshot in both directions, with every exclusion reasoned", () => {
    expect(new Set(registry).size).toBe(registry.length);
    expect(new Set(excluded).size).toBe(excluded.length);
    const routerSet = new Set(generated.router);
    for (const key of registry) {
      expect(routerSet.has(key), key).toBe(true);
      expect(excluded).not.toContain(key);
    }
    for (const key of excluded) {
      expect(routerSet.has(key), key).toBe(true);
    }
    for (const key of generated.router) {
      const covered = registry.includes(key);
      const skipped = excluded.includes(key);
      expect(covered !== skipped, key).toBe(true);
    }
    expect(registry.length + excluded.length).toBe(generated.router.length);
    expect(registry.length).toBe(29);
    expect(excluded.length).toBe(6);
    for (const row of EXCLUSIONS) {
      expect(row.reason.trim().length).toBeGreaterThan(20);
    }
    expect(readFileSync(fileURLToPath(new URL("../vendor/routes.json", import.meta.url)), "utf8")).toContain(
      "2.6.15",
    );
  });

  it("matches the generator output", () => {
    const committed = OPERATIONS.map((operation) => `${operation.tool}:${operation.action}`);
    expect(committed).toEqual(generated.actions);
    expect(excluded.sort()).toEqual([...generated.exclusions].sort());
  });

  it("keeps user out of the default toolsets", () => {
    expect(DEFAULT_TOOLSETS).not.toContain("user");
    expect(ALL_TOOLSETS).toContain("user");
    expect(parseToolsets(undefined)).toEqual([...DEFAULT_TOOLSETS]);
    expect(toolNames().some((name) => name === "wallabag_entries")).toBe(true);
  });

  it("classifies GET as read and mutating methods as write", () => {
    for (const operation of OPERATIONS) {
      if (operation.method === "GET") expect(operation.write, operation.path).toBe(false);
      else expect(operation.write, `${operation.method} ${operation.path}`).toBe(true);
    }
  });
});
