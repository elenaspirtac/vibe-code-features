import { describe, it, expect, vi, beforeEach } from "vitest";
import { VisState, VisibilityStateMachine } from "../visibility-state";

describe("VisibilityStateMachine", () => {
  let vsm: VisibilityStateMachine;

  beforeEach(() => {
    vsm = new VisibilityStateMachine();
  });

  describe("getState", () => {
    it("returns Normal for unknown elements", () => {
      expect(vsm.getState("unknown")).toBe(VisState.Normal);
    });

    it("returns the current state for tracked elements", () => {
      vsm.transition("w1", VisState.Extracted);
      expect(vsm.getState("w1")).toBe(VisState.Extracted);
    });
  });

  describe("valid transitions", () => {
    it("Normal → Extracted", () => {
      vsm.transition("w1", VisState.Extracted);
      expect(vsm.getState("w1")).toBe(VisState.Extracted);
    });

    it("Normal → FastUndo", () => {
      vsm.transition("w1", VisState.FastUndo);
      expect(vsm.getState("w1")).toBe(VisState.FastUndo);
    });

    it("Normal → Flushing", () => {
      vsm.transition("w1", VisState.Flushing);
      expect(vsm.getState("w1")).toBe(VisState.Flushing);
    });

    it("Normal → HistoryNav", () => {
      vsm.transition("w1", VisState.HistoryNav);
      expect(vsm.getState("w1")).toBe(VisState.HistoryNav);
    });

    it("Extracted → Restoring", () => {
      vsm.transition("w1", VisState.Extracted);
      vsm.transition("w1", VisState.Restoring);
      expect(vsm.getState("w1")).toBe(VisState.Restoring);
    });

    it("Extracted → Normal (deleted while extracted)", () => {
      vsm.transition("w1", VisState.Extracted);
      vsm.transition("w1", VisState.Normal);
      expect(vsm.getState("w1")).toBe(VisState.Normal);
    });

    it("Restoring → Normal", () => {
      vsm.transition("w1", VisState.Extracted);
      vsm.transition("w1", VisState.Restoring);
      vsm.transition("w1", VisState.Normal);
      expect(vsm.getState("w1")).toBe(VisState.Normal);
    });

    it("Restoring → Extracted (re-extract race)", () => {
      vsm.transition("w1", VisState.Extracted);
      vsm.transition("w1", VisState.Restoring);
      vsm.transition("w1", VisState.Extracted);
      expect(vsm.getState("w1")).toBe(VisState.Extracted);
    });

    it("FastUndo → Normal", () => {
      vsm.transition("w1", VisState.FastUndo);
      vsm.transition("w1", VisState.Normal);
      expect(vsm.getState("w1")).toBe(VisState.Normal);
    });

    it("FastUndo → Extracted", () => {
      vsm.transition("w1", VisState.FastUndo);
      vsm.transition("w1", VisState.Extracted);
      expect(vsm.getState("w1")).toBe(VisState.Extracted);
    });

    it("FastUndo → HistoryNav", () => {
      vsm.transition("w1", VisState.FastUndo);
      vsm.transition("w1", VisState.HistoryNav);
      expect(vsm.getState("w1")).toBe(VisState.HistoryNav);
    });

    it("Flushing → Normal", () => {
      vsm.transition("w1", VisState.Flushing);
      vsm.transition("w1", VisState.Normal);
      expect(vsm.getState("w1")).toBe(VisState.Normal);
    });

    it("Flushing → Extracted", () => {
      vsm.transition("w1", VisState.Flushing);
      vsm.transition("w1", VisState.Extracted);
      expect(vsm.getState("w1")).toBe(VisState.Extracted);
    });

    it("HistoryNav → Normal", () => {
      vsm.transition("w1", VisState.HistoryNav);
      vsm.transition("w1", VisState.Normal);
      expect(vsm.getState("w1")).toBe(VisState.Normal);
    });

    it("HistoryNav → Extracted", () => {
      vsm.transition("w1", VisState.HistoryNav);
      vsm.transition("w1", VisState.Extracted);
      expect(vsm.getState("w1")).toBe(VisState.Extracted);
    });

    it("same-state transition is a no-op", () => {
      vsm.transition("w1", VisState.Extracted);
      vsm.transition("w1", VisState.Extracted); // no-op
      expect(vsm.getState("w1")).toBe(VisState.Extracted);
    });
  });

  describe("illegal transitions", () => {
    it("Normal → Restoring throws", () => {
      expect(() => vsm.transition("w1", VisState.Restoring)).toThrow(
        /Illegal visibility transition.*Normal.*Restoring/
      );
    });

    it("Extracted → FastUndo throws", () => {
      vsm.transition("w1", VisState.Extracted);
      expect(() => vsm.transition("w1", VisState.FastUndo)).toThrow(
        /Illegal visibility transition.*Extracted.*FastUndo/
      );
    });

    it("Extracted → Flushing throws", () => {
      vsm.transition("w1", VisState.Extracted);
      expect(() => vsm.transition("w1", VisState.Flushing)).toThrow(
        /Illegal visibility transition.*Extracted.*Flushing/
      );
    });

    it("Restoring → FastUndo throws", () => {
      vsm.transition("w1", VisState.Extracted);
      vsm.transition("w1", VisState.Restoring);
      expect(() => vsm.transition("w1", VisState.FastUndo)).toThrow(
        /Illegal visibility transition.*Restoring.*FastUndo/
      );
    });

    it("Flushing → FastUndo throws", () => {
      vsm.transition("w1", VisState.Flushing);
      expect(() => vsm.transition("w1", VisState.FastUndo)).toThrow(
        /Illegal visibility transition.*Flushing.*FastUndo/
      );
    });

    it("HistoryNav → FastUndo throws", () => {
      vsm.transition("w1", VisState.HistoryNav);
      expect(() => vsm.transition("w1", VisState.FastUndo)).toThrow(
        /Illegal visibility transition.*HistoryNav.*FastUndo/
      );
    });
  });

  describe("transitionMany", () => {
    it("transitions multiple elements at once", () => {
      vsm.transitionMany(["w1", "w2", "w3"], VisState.Extracted);
      expect(vsm.getState("w1")).toBe(VisState.Extracted);
      expect(vsm.getState("w2")).toBe(VisState.Extracted);
      expect(vsm.getState("w3")).toBe(VisState.Extracted);
    });

    it("throws on first illegal transition", () => {
      vsm.transition("w1", VisState.Extracted);
      expect(() =>
        vsm.transitionMany(["w1"], VisState.FastUndo)
      ).toThrow(/Illegal/);
    });
  });

  describe("clear", () => {
    it("returns element to implicit Normal", () => {
      vsm.transition("w1", VisState.Extracted);
      vsm.clear("w1");
      expect(vsm.getState("w1")).toBe(VisState.Normal);
    });

    it("is a no-op for unknown elements", () => {
      vsm.clear("unknown"); // should not throw
      expect(vsm.getState("unknown")).toBe(VisState.Normal);
    });

    it("fires onTransition event", () => {
      const handler = vi.fn();
      vsm.onTransition.add(handler);
      vsm.transition("w1", VisState.FastUndo);
      handler.mockClear();

      vsm.clear("w1");
      expect(handler).toHaveBeenCalledWith({
        id: "w1",
        from: VisState.FastUndo,
        to: VisState.Normal,
      });
    });
  });

  describe("inState", () => {
    it("returns all elements in a given state", () => {
      vsm.transition("w1", VisState.Extracted);
      vsm.transition("w2", VisState.Extracted);
      vsm.transition("w3", VisState.FastUndo);

      const extracted = vsm.inState(VisState.Extracted);
      expect(extracted).toContain("w1");
      expect(extracted).toContain("w2");
      expect(extracted).not.toContain("w3");
    });

    it("throws when querying Normal (implicit state)", () => {
      expect(() => vsm.inState(VisState.Normal)).toThrow(/Cannot query Normal/);
    });
  });

  describe("hasAny", () => {
    it("returns false when no elements in state", () => {
      expect(vsm.hasAny(VisState.Extracted)).toBe(false);
    });

    it("returns true when at least one element in state", () => {
      vsm.transition("w1", VisState.Extracted);
      expect(vsm.hasAny(VisState.Extracted)).toBe(true);
    });

    it("returns false after clearing the only element", () => {
      vsm.transition("w1", VisState.Extracted);
      vsm.clear("w1");
      expect(vsm.hasAny(VisState.Extracted)).toBe(false);
    });
  });

  describe("dirty flag", () => {
    it("defaults to not dirty", () => {
      vsm.transition("w1", VisState.Extracted);
      expect(vsm.isDirty("w1")).toBe(false);
    });

    it("can be marked dirty when Extracted", () => {
      vsm.transition("w1", VisState.Extracted);
      vsm.markDirty("w1");
      expect(vsm.isDirty("w1")).toBe(true);
    });

    it("markDirty is ignored for non-Extracted elements", () => {
      vsm.transition("w1", VisState.FastUndo);
      vsm.markDirty("w1"); // no-op
      expect(vsm.isDirty("w1")).toBe(false);
    });

    it("markDirty is ignored for unknown elements", () => {
      vsm.markDirty("unknown"); // no-op
      expect(vsm.isDirty("unknown")).toBe(false);
    });

    it("dirty flag survives Extracted → Restoring (needed for flush)", () => {
      vsm.transition("w1", VisState.Extracted);
      vsm.markDirty("w1");
      expect(vsm.isDirty("w1")).toBe(true);

      vsm.transition("w1", VisState.Restoring);
      expect(vsm.isDirty("w1")).toBe(true); // survives for restore flush
    });

    it("dirty flag is cleared when leaving Extracted to Normal", () => {
      vsm.transition("w1", VisState.Extracted);
      vsm.markDirty("w1");
      expect(vsm.isDirty("w1")).toBe(true);

      vsm.transition("w1", VisState.Normal);
      expect(vsm.isDirty("w1")).toBe(false);
    });
  });

  describe("onTransition event", () => {
    it("fires on valid transition", () => {
      const handler = vi.fn();
      vsm.onTransition.add(handler);

      vsm.transition("w1", VisState.Extracted);
      expect(handler).toHaveBeenCalledWith({
        id: "w1",
        from: VisState.Normal,
        to: VisState.Extracted,
      });
    });

    it("does not fire on same-state no-op", () => {
      vsm.transition("w1", VisState.Extracted);
      const handler = vi.fn();
      vsm.onTransition.add(handler);

      vsm.transition("w1", VisState.Extracted); // no-op
      expect(handler).not.toHaveBeenCalled();
    });

    it("fires on transition back to Normal (deletion from map)", () => {
      vsm.transition("w1", VisState.Extracted);
      const handler = vi.fn();
      vsm.onTransition.add(handler);

      vsm.transition("w1", VisState.Normal);
      expect(handler).toHaveBeenCalledWith({
        id: "w1",
        from: VisState.Extracted,
        to: VisState.Normal,
      });
    });
  });

  describe("reset", () => {
    it("clears all tracked state", () => {
      vsm.transition("w1", VisState.Extracted);
      vsm.transition("w2", VisState.FastUndo);
      vsm.markDirty("w1");

      vsm.reset();

      expect(vsm.getState("w1")).toBe(VisState.Normal);
      expect(vsm.getState("w2")).toBe(VisState.Normal);
      expect(vsm.isDirty("w1")).toBe(false);
      expect(vsm.size).toBe(0);
    });
  });

  describe("size", () => {
    it("returns 0 when empty", () => {
      expect(vsm.size).toBe(0);
    });

    it("reflects tracked element count", () => {
      vsm.transition("w1", VisState.Extracted);
      vsm.transition("w2", VisState.FastUndo);
      expect(vsm.size).toBe(2);
    });

    it("decreases when element returns to Normal", () => {
      vsm.transition("w1", VisState.Extracted);
      vsm.transition("w1", VisState.Normal);
      expect(vsm.size).toBe(0);
    });
  });
});
