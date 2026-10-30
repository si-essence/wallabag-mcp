import { describe, expect, it } from "vitest";
import { fillExpressPath } from "../src/json.js";

describe("fillExpressPath", () => {
  it("fills required Express params and drops optional segments when empty", () => {
    expect(fillExpressPath("/api/libraries/:id", { id: "lib-1" })).toBe("api/libraries/lib-1");
    expect(
      fillExpressPath("/api/playlists/:id/item/:libraryItemId/:episodeId?", {
        id: "pl-1",
        libraryItemId: "li-1",
      }),
    ).toBe("api/playlists/pl-1/item/li-1");
    expect(
      fillExpressPath("/api/playlists/:id/item/:libraryItemId/:episodeId?", {
        id: "pl-1",
        libraryItemId: "li-1",
        episodeId: "ep-9",
      }),
    ).toBe("api/playlists/pl-1/item/li-1/ep-9");
  });
});
