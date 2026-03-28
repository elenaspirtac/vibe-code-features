import { describe, it, expect } from "vitest";
import {
  ElementRegistry,
  BUILTIN_RELATIONSHIP_BEHAVIORS,
} from "../registry";
import type { RelationshipBehavior } from "../registry";
import type { BimDocument } from "../document";

describe("ElementRegistry — relationship behaviors (S.5)", () => {
  // ── Built-in types ───────────────────────────────────────────────

  describe("built-in relationship types", () => {
    const registry = new ElementRegistry();

    it("hosts: recurse extract/restore, cascade delete, refresh on change", () => {
      const b = registry.getRelationshipBehavior("hosts");
      expect(b.onExtract).toBe("recurse");
      expect(b.onRestore).toBe("recurse");
      expect(b.onDelete).toBe("cascade");
      expect(b.onChange).toBe("refresh");
    });

    it("hostedBy: recurse extract/restore, skip delete, refresh on change", () => {
      const b = registry.getRelationshipBehavior("hostedBy");
      expect(b.onExtract).toBe("recurse");
      expect(b.onRestore).toBe("recurse");
      expect(b.onDelete).toBe("skip");
      expect(b.onChange).toBe("refresh");
    });

    it("connectedTo: include extract/restore, skip delete, refresh on change", () => {
      const b = registry.getRelationshipBehavior("connectedTo");
      expect(b.onExtract).toBe("include");
      expect(b.onRestore).toBe("include");
      expect(b.onDelete).toBe("skip");
      expect(b.onChange).toBe("refresh");
    });
  });

  // ── Custom relationship types ────────────────────────────────────

  describe("custom relationship types", () => {
    it("registerRelationshipType adds a new type", () => {
      const registry = new ElementRegistry();
      const custom: RelationshipBehavior = {
        onExtract: "skip",
        onRestore: "skip",
        onDelete: "skip",
        onChange: "skip",
      };
      registry.registerRelationshipType("weakRef", custom);
      expect(registry.getRelationshipBehavior("weakRef")).toEqual(custom);
    });

    it("registerRelationshipType can override a built-in", () => {
      const registry = new ElementRegistry();
      const override: RelationshipBehavior = {
        onExtract: "skip",
        onRestore: "skip",
        onDelete: "skip",
        onChange: "skip",
      };
      registry.registerRelationshipType("hosts", override);
      expect(registry.getRelationshipBehavior("hosts")).toEqual(override);
    });
  });

  // ── Fallback for unknown types ───────────────────────────────────

  describe("unknown relationship types", () => {
    it("returns safe defaults for an unregistered type", () => {
      const registry = new ElementRegistry();
      const b = registry.getRelationshipBehavior("unknownType");
      expect(b.onExtract).toBe("include");
      expect(b.onRestore).toBe("include");
      expect(b.onDelete).toBe("skip");
      expect(b.onChange).toBe("refresh");
    });
  });

  // ── Cascade delete resolution ────────────────────────────────────

  describe("resolveCascadeDelete", () => {
    it("returns hosted children for a wall with windows", () => {
      const registry = new ElementRegistry();
      registry.register({
        kind: "wall",
        generateGeometry: () => { throw new Error("unused"); },
        getRelationships(contract) {
          return [
            { type: "hosts", targetId: "win1" },
            { type: "connectedTo", targetId: "w2" },
          ];
        },
      });

      const mockDoc = {
        contracts: new Map([
          ["w1", { id: "w1", kind: "wall" }],
          ["win1", { id: "win1", kind: "window" }],
          ["w2", { id: "w2", kind: "wall" }],
        ]),
      } as unknown as BimDocument;

      const result = registry.resolveCascadeDelete("w1", mockDoc);
      expect(result).toEqual(["win1"]); // only hosted child, not connected peer
    });

    it("returns empty for element with no cascade-delete relationships", () => {
      const registry = new ElementRegistry();
      registry.register({
        kind: "floor",
        generateGeometry: () => { throw new Error("unused"); },
        getRelationships() {
          return [
            { type: "connectedTo", targetId: "w1" },
            { type: "connectedTo", targetId: "w2" },
          ];
        },
      });

      const mockDoc = {
        contracts: new Map([
          ["f1", { id: "f1", kind: "floor" }],
        ]),
      } as unknown as BimDocument;

      const result = registry.resolveCascadeDelete("f1", mockDoc);
      expect(result).toEqual([]);
    });

    it("returns empty for missing contract", () => {
      const registry = new ElementRegistry();
      const mockDoc = {
        contracts: new Map(),
      } as unknown as BimDocument;

      const result = registry.resolveCascadeDelete("missing", mockDoc);
      expect(result).toEqual([]);
    });
  });

  // ── BUILTIN_RELATIONSHIP_BEHAVIORS export ────────────────────────

  describe("BUILTIN_RELATIONSHIP_BEHAVIORS", () => {
    it("exports all three built-in types", () => {
      expect(Object.keys(BUILTIN_RELATIONSHIP_BEHAVIORS)).toEqual(
        expect.arrayContaining(["hosts", "hostedBy", "connectedTo"])
      );
    });
  });

  // ── Schema migration (S.7) ───────────────────────────────────────

  describe("schema migration", () => {
    it("getVersion returns 1 for types without explicit version", () => {
      const registry = new ElementRegistry();
      registry.register({
        kind: "wall",
        generateGeometry: () => { throw new Error("unused"); },
        getRelationships: () => [],
      });
      expect(registry.getVersion("wall")).toBe(1);
    });

    it("getVersion returns declared version", () => {
      const registry = new ElementRegistry();
      registry.register({
        kind: "wall",
        version: 3,
        generateGeometry: () => { throw new Error("unused"); },
        getRelationships: () => [],
      });
      expect(registry.getVersion("wall")).toBe(3);
    });

    it("getVersion returns 1 for unknown kind", () => {
      const registry = new ElementRegistry();
      expect(registry.getVersion("unknown")).toBe(1);
    });

    it("migrateContract returns unchanged if already at current version", () => {
      const registry = new ElementRegistry();
      registry.register({
        kind: "wall",
        version: 2,
        migrations: { 1: (c) => ({ ...c, material: "concrete" }) },
        generateGeometry: () => { throw new Error("unused"); },
        getRelationships: () => [],
      });

      const contract = { id: "w1", kind: "wall", height: 3 };
      const result = registry.migrateContract(contract, 2);
      expect(result).toBe(contract); // same reference, not migrated
    });

    it("migrateContract runs single migration v1→v2", () => {
      const registry = new ElementRegistry();
      registry.register({
        kind: "wall",
        version: 2,
        migrations: {
          1: (c) => ({ ...c, material: "concrete" }),
        },
        generateGeometry: () => { throw new Error("unused"); },
        getRelationships: () => [],
      });

      const result = registry.migrateContract(
        { id: "w1", kind: "wall", height: 3 },
        1
      );
      expect(result).toEqual({ id: "w1", kind: "wall", height: 3, material: "concrete" });
    });

    it("migrateContract chains migrations v1→v2→v3", () => {
      const registry = new ElementRegistry();
      registry.register({
        kind: "wall",
        version: 3,
        migrations: {
          1: (c) => ({ ...c, material: "concrete" }),
          2: (c) => {
            const { offset, ...rest } = c as any;
            return { ...rest, centerlineOffset: offset ?? 0 };
          },
        },
        generateGeometry: () => { throw new Error("unused"); },
        getRelationships: () => [],
      });

      const result = registry.migrateContract(
        { id: "w1", kind: "wall", height: 3, offset: 0.1 },
        1
      );
      expect(result).toEqual({
        id: "w1", kind: "wall", height: 3,
        material: "concrete",
        centerlineOffset: 0.1,
      });
    });

    it("migrateContract throws on missing migration in chain", () => {
      const registry = new ElementRegistry();
      registry.register({
        kind: "wall",
        version: 3,
        migrations: {
          // v1→v2 missing!
          2: (c) => ({ ...c, extra: true }),
        },
        generateGeometry: () => { throw new Error("unused"); },
        getRelationships: () => [],
      });

      expect(() =>
        registry.migrateContract({ id: "w1", kind: "wall" }, 1)
      ).toThrow(/Missing migration for "wall" from v1 to v2/);
    });

    it("migrateContract passes through unknown kinds unchanged", () => {
      const registry = new ElementRegistry();
      const raw = { id: "x1", kind: "alien", data: 42 };
      const result = registry.migrateContract(raw, 1);
      expect(result).toBe(raw);
    });

    it("migrateAll migrates all contracts and stamps _v", () => {
      const registry = new ElementRegistry();
      registry.register({
        kind: "wall",
        version: 2,
        migrations: {
          1: (c) => ({ ...c, material: "concrete" }),
        },
        generateGeometry: () => { throw new Error("unused"); },
        getRelationships: () => [],
      });
      registry.register({
        kind: "window",
        // version 1, no migrations
        generateGeometry: () => { throw new Error("unused"); },
        getRelationships: () => [],
      });

      const input: [string, Record<string, unknown>][] = [
        ["w1", { id: "w1", kind: "wall", height: 3 }],             // no _v → defaults to 1
        ["w2", { id: "w2", kind: "wall", height: 4, _v: 1 }],     // explicit v1
        ["win1", { id: "win1", kind: "window", _v: 1 }],           // already current
      ];

      const result = registry.migrateAll(input);
      expect(result).toHaveLength(3);

      // w1: migrated v1→v2
      expect(result[0][1]).toMatchObject({ kind: "wall", height: 3, material: "concrete", _v: 2 });
      // w2: migrated v1→v2
      expect(result[1][1]).toMatchObject({ kind: "wall", height: 4, material: "concrete", _v: 2 });
      // win1: already v1 (current), just stamped
      expect(result[2][1]).toMatchObject({ kind: "window", _v: 1 });
    });

    it("migrateAll handles files saved before versioning (_v absent)", () => {
      const registry = new ElementRegistry();
      registry.register({
        kind: "wall",
        // version 1 (default), no migrations needed
        generateGeometry: () => { throw new Error("unused"); },
        getRelationships: () => [],
      });

      const input: [string, Record<string, unknown>][] = [
        ["w1", { id: "w1", kind: "wall", height: 3 }], // no _v field at all
      ];

      const result = registry.migrateAll(input);
      expect(result[0][1]).toMatchObject({ kind: "wall", height: 3, _v: 1 });
    });
  });
});
