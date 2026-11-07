import { describe, expect, it } from "vitest";

import { restoreTool } from "../src/commands/restores.js";

describe("restoreTool", () => {
  it("adds --oplogReplay for MongoDB dumps taken with the oplog", () => {
    expect(restoreTool("mongo_archive", "mongodb://h/db", false, true)?.args).toEqual([
      "--archive",
      "--oplogReplay",
      "--uri",
      "mongodb://h/db",
    ]);
    expect(restoreTool("mongo_archive", "mongodb://h/db", true)?.args).toEqual([
      "--archive",
      "--drop",
      "--uri",
      "mongodb://h/db",
    ]);
  });

  it("keeps the MySQL password out of the arguments", () => {
    const tool = restoreTool("mysql_sql", "mysql://root:s%40cret@db.local:3307/shop", false);
    expect(tool?.command).toBe("mysql");
    expect(tool?.args).toEqual(["--host", "db.local", "--port", "3307", "--user", "root", "shop"]);
    expect(tool?.args.join(" ")).not.toContain("cret");
    expect(tool?.env).toEqual({ MYSQL_PWD: "s@cret" });
  });

  it("has nothing for Convex", () => {
    expect(restoreTool("convex_zip", "x", false)).toBeUndefined();
  });
});
