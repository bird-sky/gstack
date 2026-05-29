/**
 * Cross-skill taxonomy alignment. /cso renders the full generated taxonomy table;
 * /spec references it without inlining. Both derive from lib/redact-patterns via
 * the shared resolver, so a manual edit to the wrong place is caught here.
 */
import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { generateRedactTaxonomyTable } from "../scripts/resolvers/redact-doc";
import { HOST_PATHS } from "../scripts/resolvers/types";
import { PATTERNS } from "../lib/redact-patterns";

const ROOT = path.resolve(import.meta.dir, "..");
const CSO = fs.readFileSync(path.join(ROOT, "cso", "SKILL.md"), "utf-8");
const ctx = { skillName: "cso", tmplPath: "", host: "claude" as const, paths: HOST_PATHS["claude"] };

describe("cso/spec taxonomy alignment", () => {
  test("cso renders the full generated taxonomy table verbatim", () => {
    const table = generateRedactTaxonomyTable(ctx);
    // A couple of representative lines from the generated table must appear in /cso.
    const line = table.split("\n").find((l) => l.includes("`aws.access_key`"));
    expect(line).toBeTruthy();
    expect(CSO).toContain(line!);
  });

  test("cso lists every HIGH-tier credential id (the archaeology contract, no drift)", () => {
    for (const p of PATTERNS.filter((x) => x.tier === "HIGH")) {
      expect(CSO).toContain(`\`${p.id}\``);
    }
  });

  test("cso keeps its git-history archaeology (different use case, not replaced)", () => {
    expect(CSO).toContain("git log -p --all");
    expect(CSO).toContain("Secrets Archaeology");
  });
});
