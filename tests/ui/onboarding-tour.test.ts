import { describe, expect, it } from "vitest";
import { calculateTourCardPosition } from "../../src/ui/onboarding-tour.js";

describe("onboarding tour placement", () => {
  const target = { left: 100, top: 100, right: 300, bottom: 200, width: 200, height: 100 };
  const card = { width: 160, height: 80 };
  const viewport = { width: 800, height: 600 };

  it("places the coach card beside the real target", () => {
    expect(calculateTourCardPosition(target, card, viewport, "right")).toEqual({
      left: 312,
      top: 100,
    });
    expect(calculateTourCardPosition(target, card, viewport, "bottom")).toEqual({
      left: 120,
      top: 212,
    });
  });

  it("flips and clamps the card inside a narrow viewport", () => {
    const nearEdge = { left: 660, top: 520, right: 790, bottom: 590, width: 130, height: 70 };
    expect(calculateTourCardPosition(nearEdge, card, viewport, "right")).toEqual({
      left: 488,
      top: 508,
    });
    expect(calculateTourCardPosition(nearEdge, card, viewport, "bottom")).toEqual({
      left: 628,
      top: 428,
    });
  });
});
