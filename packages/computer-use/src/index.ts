/**
 * Computer Use action protocol. The execution layer owns coordinate conversion and
 * display metadata; the model only emits logical actions.
 */

export type MouseButton = "left" | "right" | "middle";

export interface ScreenPoint {
  x: number;
  y: number;
}

export type ComputerAction =
  | { type: "screenshot"; displayId?: number }
  | {
      type: "click";
      point: ScreenPoint;
      button?: MouseButton;
      count?: 1 | 2;
      screenshotId?: string;
    }
  | { type: "move"; point: ScreenPoint }
  | { type: "scroll"; deltaX: number; deltaY: number; point?: ScreenPoint }
  | { type: "type_text"; text: string }
  | { type: "keypress"; keys: readonly string[] }
  | { type: "drag"; from: ScreenPoint; to: ScreenPoint }
  | { type: "wait"; milliseconds: number };

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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPoint(value: unknown): value is ScreenPoint {
  return (
    typeof value === "object" &&
    value !== null &&
    isFiniteNumber((value as ScreenPoint).x) &&
    isFiniteNumber((value as ScreenPoint).y) &&
    (value as ScreenPoint).x >= 0 &&
    (value as ScreenPoint).y >= 0
  );
}

export function validateComputerAction(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof input !== "object" || input === null || !("type" in input)) {
    return { ok: false, errors: ["Action must be an object with a type"] };
  }

  const action = input as Record<string, unknown>;
  switch (action.type) {
    case "screenshot":
      if (action.displayId !== undefined && !isFiniteNumber(action.displayId)) {
        errors.push("displayId must be a finite number");
      }
      break;
    case "click": {
      if (!isPoint(action.point)) {
        errors.push("point must be a non-negative screen coordinate");
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
      if (!isPoint(action.point)) {
        errors.push("point must be a non-negative screen coordinate");
      }
      break;
    case "scroll":
      if (!isFiniteNumber(action.deltaX) || !isFiniteNumber(action.deltaY)) {
        errors.push("deltaX and deltaY must be finite numbers");
      }
      if (action.point !== undefined && !isPoint(action.point)) {
        errors.push("point must be a non-negative screen coordinate when provided");
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
      if (!isPoint(action.from) || !isPoint(action.to)) {
        errors.push("from and to must be non-negative screen coordinates");
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
