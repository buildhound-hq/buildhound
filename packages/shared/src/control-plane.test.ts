import { describe, expect, it } from "vitest";
import { ListMachinesResponse, MachineActivity } from "./control-plane";

describe("machine activity schema", () => {
  it("keeps a kind it knows", () => {
    expect(MachineActivity.parse({ at: "2026-10-21T11:40:00Z", kind: "hosted", text: "New jobs went to GitHub-hosted" }).kind).toBe("hosted");
  });

  it("reads a kind it doesn't know as other, so a newer API never fails an older dashboard", () => {
    const a = MachineActivity.parse({ at: "2026-10-21T11:44:00Z", kind: "kind_from_a_newer_api", text: "Something new" });
    expect(a).toEqual({ at: "2026-10-21T11:44:00Z", kind: "other", text: "Something new" });
  });

  it("parses a machines list that carries an unknown kind", () => {
    const shape = ListMachinesResponse.shape.machines.element.shape.activity.unwrap();
    expect(shape.parse([{ at: "2026-10-21T11:44:00Z", kind: "kind_from_a_newer_api", text: "x" }])[0]!.kind).toBe("other");
  });
});
