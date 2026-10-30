import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CONNECTOR_NAME } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { DEFAULT_TOOLSETS, toolsForToolsets } from "../src/operations.js";
import { createRuntime } from "../src/runtime.js";
import { connectServer } from "./mcp.js";

const TOKEN = "super-secret/key+value=99";

describe("server", () => {
  it("publishes the default toolsets and omits user", async () => {
    const runtime = createRuntime(
      loadConfig({ WALLABAG_BASE_URL: "http://127.0.0.1:80", WALLABAG_ACCESS_TOKEN: TOKEN }, []),
    );
    const { client, close } = await connectServer(runtime);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
        toolsForToolsets(DEFAULT_TOOLSETS),
      );
      expect(listed.tools.map((tool) => tool.name)).not.toContain("wallabag_user");
    } finally {
      await close();
    }
  });

  it("keeps the package name aligned with package.json", () => {
    const pkg = z
      .object({ name: z.string() })
      .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
    expect(pkg.name).toBe(CONNECTOR_NAME);
  });
});
