import { describe, expect, it } from "vitest";
import { shouldHideWindowOnClose, shouldQuitWhenAllWindowsClosed } from "./window-behavior";

describe("window close behavior", () => {
  it("hides to tray only when the user chose background running", () => {
    expect(
      shouldHideWindowOnClose({
        isQuitting: false,
        closeBehavior: "keep_running",
        hasTray: true,
      }),
    ).toBe(true);
    expect(
      shouldHideWindowOnClose({
        isQuitting: false,
        closeBehavior: "quit",
        hasTray: true,
      }),
    ).toBe(false);
    expect(
      shouldHideWindowOnClose({
        isQuitting: true,
        closeBehavior: "keep_running",
        hasTray: true,
      }),
    ).toBe(false);
  });

  it("quits when the user chose quit or no tray exists", () => {
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: "win32",
        closeBehavior: "quit",
        hasTray: false,
      }),
    ).toBe(true);
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: "win32",
        closeBehavior: "keep_running",
        hasTray: true,
      }),
    ).toBe(false);
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: "win32",
        closeBehavior: "keep_running",
        hasTray: false,
      }),
    ).toBe(true);
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: "darwin",
        closeBehavior: "quit",
        hasTray: true,
      }),
    ).toBe(true);
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: "darwin",
        closeBehavior: "keep_running",
        hasTray: false,
      }),
    ).toBe(false);
  });
});
