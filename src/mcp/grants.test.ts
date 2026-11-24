import { describe, expect, it } from "vitest";
import type { Grant } from "./api";
import { accessOf, grantLevel, vaultRows } from "./grants";

const vault = (id: string) => ({ id, name: id.toUpperCase(), path: `/${id}` });
const grant = (vaultId: string, access: Grant["access"]): Grant => ({
  vaultId,
  vaultName: vaultId.toUpperCase(),
  vaultPath: `/${vaultId}`,
  access,
});

describe("grants", () => {
  it("tells what a client may do", () => {
    const client = { grants: [grant("a", "read"), grant("b", "write")] };
    expect(["a", "b", "c"].map((id) => grantLevel(client, id))).toEqual(["read", "write", "none"]);
    expect([accessOf("none"), accessOf("read"), accessOf("write")]).toEqual([null, "read", "write"]);
  });

  it("lists the open vault first, then those with access, then the rest", () => {
    const client = { grants: [grant("gone", "read"), grant("open", "write")] };
    const rows = vaultRows(client, vault("open"), [vault("open"), vault("other")]);
    expect(rows.map((r) => [r.id, r.open])).toEqual([
      ["open", true],
      ["gone", false],
      ["other", false],
    ]);
    expect(rows[1]).toMatchObject({ name: "GONE", path: "/gone" });
  });

  it("works with no vault open", () => {
    expect(vaultRows({ grants: [] }, null, [vault("a")])).toEqual([{ ...vault("a"), open: false }]);
  });
});
