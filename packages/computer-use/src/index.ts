/**
 * Computer Use action protocol. The execution layer owns coordinate conversion and
 * display metadata; the model only emits logical actions.
 */

export type MouseButton = "left" | "right" | "middle";

/** Pixels are absolute desktop coordinates; normalized coordinates are 0..1. */
export type CoordinateSpace = "pixels" | "normalized";

export interface ScreenPoint {
  x: number;
  y: number;
}

export const COMPUTER_ACTION_TYPES = [
  "screenshot",
  "click",
  "move",
  "scroll",
  "type_text",
  "keypress",
  "drag",
  "wait",
] as const;
export type ComputerActionType = (typeof COMPUTER_ACTION_TYPES)[number];

export type ComputerAction =
  | { type: "screenshot"; displayId?: number }
  | {
      type: "click";
      point: ScreenPoint;
      button?: MouseButton;
      count?: 1 | 2;
      screenshotId?: string;
      coordinateSpace?: CoordinateSpace;
    }
  | { type: "move"; point: ScreenPoint; screenshotId?: string; coordinateSpace?: CoordinateSpace }
  | {
      type: "scroll";
      deltaX: number;
      deltaY: number;
      point?: ScreenPoint;
      screenshotId?: string;
      coordinateSpace?: CoordinateSpace;
    }
  | { type: "type_text"; text: string; screenshotId?: string }
  | { type: "keypress"; keys: readonly string[]; screenshotId?: string }
  | {
      type: "drag";
      from: ScreenPoint;
      to: ScreenPoint;
      screenshotId?: string;
      coordinateSpace?: CoordinateSpace;
    }
  | { type: "wait"; milliseconds: number; screenshotId?: string };

export interface ActionResult {
  actionId: string;
  taskId: string;
  vmId: string;
  ok: boolean;
  errorCode?: string;
  screenshotRef?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: readonly string[];
}

const MAX_KEYS = 4;
const MAX_TEXT_LENGTH = 20_000;
const MAX_WAIT_MS = 30_000;

const MAX_SCREENSHOT_ID_LENGTH = 128;
const SCREENSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPoint(
  value: unknown,
  coordinateSpace: CoordinateSpace = "pixels",
): value is ScreenPoint {
  if (typeof value !== "object" || value === null) return false;
  const point = value as ScreenPoint;
  if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) return false;
  if (point.x < 0 || point.y < 0) return false;
  return coordinateSpace === "normalized" ? point.x <= 1 && point.y <= 1 : true;
}

function isCoordinateSpace(value: unknown): value is CoordinateSpace {
  return value === "pixels" || value === "normalized";
}

function isScreenshotId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_SCREENSHOT_ID_LENGTH &&
    SCREENSHOT_ID_PATTERN.test(value)
  );
}

export function validateComputerAction(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof input !== "object" || input === null || !("type" in input)) {
    return { ok: false, errors: ["Action must be an object with a type"] };
  }

  const action = input as Record<string, unknown>;
  const coordinateSpace = action.coordinateSpace;
  if (coordinateSpace !== undefined && !isCoordinateSpace(coordinateSpace)) {
    errors.push("coordinateSpace must be pixels or normalized");
  }
  const space: CoordinateSpace = isCoordinateSpace(coordinateSpace) ? coordinateSpace : "pixels";

  if (action.screenshotId !== undefined && !isScreenshotId(action.screenshotId)) {
    errors.push("screenshotId must be a valid screenshot reference");
  }

  switch (action.type) {
    case "screenshot":
      if (action.displayId !== undefined && !isFiniteNumber(action.displayId)) {
        errors.push("displayId must be a finite number");
      }
      break;
    case "click": {
      if (!isPoint(action.point, space)) {
        errors.push(
          space === "normalized"
            ? "point must be a normalized coordinate between 0 and 1"
            : "point must be a non-negative screen coordinate",
        );
      }
      if (
        action.button !== undefined &&
        !["left", "right", "middle"].includes(String(action.button))
      ) {
        errors.push("button must be left, right or middle");
      }
      if (action.count !== undefined && action.count !== 1 && action.count !== 2) {
        errors.push("count must be 1 or 2");
      }
      break;
    }
    case "move":
      if (!isPoint(action.point, space)) {
        errors.push(
          space === "normalized"
            ? "point must be a normalized coordinate between 0 and 1"
            : "point must be a non-negative screen coordinate",
        );
      }
      break;
    case "scroll":
      if (!isFiniteNumber(action.deltaX) || !isFiniteNumber(action.deltaY)) {
        errors.push("deltaX and deltaY must be finite numbers");
      }
      if (action.point !== undefined && !isPoint(action.point, space)) {
        errors.push(
          space === "normalized"
            ? "point must be a normalized coordinate between 0 and 1 when provided"
            : "point must be a non-negative screen coordinate when provided",
        );
      }
      break;
    case "type_text":
      if (typeof action.text !== "string" || action.text.length === 0) {
        errors.push("text must be a non-empty string");
      } else if (action.text.length > MAX_TEXT_LENGTH) {
        errors.push(`text exceeds ${MAX_TEXT_LENGTH} characters`);
      }
      break;
    case "keypress":
      if (
        !Array.isArray(action.keys) ||
        action.keys.length === 0 ||
        action.keys.length > MAX_KEYS ||
        !action.keys.every((key) => typeof key === "string" && key.length > 0)
      ) {
        errors.push("keys must be 1-4 non-empty strings");
      }
      break;
    case "drag":
      if (!isPoint(action.from, space) || !isPoint(action.to, space)) {
        errors.push(
          space === "normalized"
            ? "from and to must be normalized coordinates between 0 and 1"
            : "from and to must be non-negative screen coordinates",
        );
      }
      break;
    case "wait":
      if (
        !isFiniteNumber(action.milliseconds) ||
        action.milliseconds < 0 ||
        action.milliseconds > MAX_WAIT_MS
      ) {
        errors.push(`milliseconds must be between 0 and ${MAX_WAIT_MS}`);
      }
      break;
    default:
      errors.push(`Unsupported action type: ${String(action.type)}`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The model may work with coordinates normalized to the screenshot it observed.
 * Conversion to absolute desktop pixels happens here, in the execution layer, so
 * the model contract never depends on the current resolution or DPI.
 */
export function convertComputerActionCoordinates(
  action: ComputerAction,
  width: number,
  height: number,
): ComputerAction {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("display dimensions must be positive integers");
  }
  if (action.type === "screenshot") return action;
  const space: CoordinateSpace =
    "coordinateSpace" in action ? (action.coordinateSpace ?? "pixels") : "pixels";
  if (space === "pixels") return action;

  const convert = (point: ScreenPoint): ScreenPoint => ({
    x: Math.min(width - 1, Math.max(0, Math.round(point.x * width))),
    y: Math.min(height - 1, Math.max(0, Math.round(point.y * height))),
  });

  switch (action.type) {
    case "click":
      return { ...action, point: convert(action.point), coordinateSpace: "pixels" };
    case "move":
      return { ...action, point: convert(action.point), coordinateSpace: "pixels" };
    case "scroll":
      return {
        ...action,
        ...(action.point ? { point: convert(action.point) } : {}),
        coordinateSpace: "pixels",
      };
    case "drag":
      return {
        ...action,
        from: convert(action.from),
        to: convert(action.to),
        coordinateSpace: "pixels",
      };
    default:
      return action;
  }
}

/**
 * Stable signature used for duplicate and no-progress detection. Volatile
 * references (actionId in the caller envelope, screenshot id) are excluded so a
 * model cannot evade detection merely by taking a new screenshot.
 */
export function computerActionSignature(action: ComputerAction): string {
  const { screenshotId: _screenshotId, ...rest } = action as ComputerAction & {
    screenshotId?: string;
  };
  void _screenshotId;
  return stableStringify(rest);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export interface DisplayGeometry {
  width: number;
  height: number;
  dpi?: number;
  scaleFactor?: number;
}

/** Returns an error when the observed screenshot no longer matches the display. */
export function assertActionFitsDisplay(
  action: ComputerAction,
  display: DisplayGeometry,
): ValidationResult {
  const errors: string[] = [];
  const points: ScreenPoint[] = [];
  if (action.type === "click" || action.type === "move") points.push(action.point);
  if (action.type === "scroll" && action.point) points.push(action.point);
  if (action.type === "drag") points.push(action.from, action.to);
  for (const point of points) {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x >= display.width ||
      point.y >= display.height
    ) {
      errors.push(
        `point (${point.x},${point.y}) is outside ${display.width}x${display.height} display`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}
