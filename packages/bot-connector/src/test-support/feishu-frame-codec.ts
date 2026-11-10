/**
 * TEST-ONLY protobuf codec for Feishu long-connection frames.
 *
 * Production Feishu ingress uses the official `@larksuiteoapi/node-sdk`
 * WSClient. This codec exists only so the local mock server can speak the
 * official wire format and exercise that SDK in tests.
 *
 * Field numbers come from the official larksuite/oapi-sdk-go ws/pbbp2 proto:
 *
 *   message Header { required string key = 1; required string value = 2; }
 *   message Frame {
 *     required uint64 SeqID = 1;
 *     required uint64 LogID = 2;
 *     required int32 service = 3;
 *     required int32 method = 4;
 *     repeated Header headers = 5;
 *     optional string payload_encoding = 6;
 *     optional string payload_type = 7;
 *     optional bytes payload = 8;
 *     optional string LogIDNew = 9;
 *   }
 *
 * Frame.method: 0 = control (ping/pong), 1 = data (event/card).
 */

export const FEISHU_FRAME_METHOD_CONTROL = 0;
export const FEISHU_FRAME_METHOD_DATA = 1;

export type FeishuMessageType = "event" | "card" | "ping" | "pong";

export interface FeishuFrameHeader {
  key: string;
  value: string;
}

export interface FeishuFrame {
  seqId: bigint;
  logId: bigint;
  service: number;
  method: number;
  headers: FeishuFrameHeader[];
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Uint8Array;
  logIdNew?: string;
}

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeVarint(value: bigint, out: number[]): void {
  if (value < 0n) {
    throw new Error("negative varint is not supported");
  }
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (remaining > 0n);
}

function encodeTag(fieldNumber: number, wireType: number, out: number[]): void {
  encodeVarint(BigInt((fieldNumber << 3) | wireType), out);
}

function encodeLengthDelimited(fieldNumber: number, bytes: Uint8Array, out: number[]): void {
  encodeTag(fieldNumber, WIRE_LENGTH_DELIMITED, out);
  encodeVarint(BigInt(bytes.byteLength), out);
  for (const byte of bytes) {
    out.push(byte);
  }
}

function encodeString(fieldNumber: number, value: string, out: number[]): void {
  encodeLengthDelimited(fieldNumber, textEncoder.encode(value), out);
}

function readVarint(bytes: Uint8Array, offset: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < bytes.byteLength) {
    const byte = bytes[cursor];
    if (byte === undefined) {
      break;
    }
    cursor += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, next: cursor };
    }
    shift += 7n;
    if (shift > 63n) {
      throw new Error("varint is too long");
    }
  }
  throw new Error("truncated varint");
}

export function encodeFeishuFrame(frame: FeishuFrame): Uint8Array {
  const out: number[] = [];
  encodeTag(1, WIRE_VARINT, out);
  encodeVarint(frame.seqId, out);
  encodeTag(2, WIRE_VARINT, out);
  encodeVarint(frame.logId, out);
  encodeTag(3, WIRE_VARINT, out);
  encodeVarint(BigInt(frame.service), out);
  encodeTag(4, WIRE_VARINT, out);
  encodeVarint(BigInt(frame.method), out);

  for (const header of frame.headers) {
    const headerBytes: number[] = [];
    encodeString(1, header.key, headerBytes);
    encodeString(2, header.value, headerBytes);
    encodeLengthDelimited(5, Uint8Array.from(headerBytes), out);
  }

  if (frame.payloadEncoding !== undefined) {
    encodeString(6, frame.payloadEncoding, out);
  }
  if (frame.payloadType !== undefined) {
    encodeString(7, frame.payloadType, out);
  }
  if (frame.payload !== undefined) {
    encodeLengthDelimited(8, frame.payload, out);
  }
  if (frame.logIdNew !== undefined) {
    encodeString(9, frame.logIdNew, out);
  }
  return Uint8Array.from(out);
}

function decodeHeader(bytes: Uint8Array): FeishuFrameHeader {
  const fields = decodeFields(bytes);
  let key = "";
  let value = "";
  for (const field of fields) {
    if (field.fieldNumber === 1) {
      key = decodeUtf8(field);
    } else if (field.fieldNumber === 2) {
      value = decodeUtf8(field);
    }
  }
  return { key, value };
}

interface DecodedField {
  fieldNumber: number;
  wireType: number;
  varint?: bigint;
  bytes?: Uint8Array;
}

function decodeFields(bytes: Uint8Array): DecodedField[] {
  const fields: DecodedField[] = [];
  let cursor = 0;
  while (cursor < bytes.byteLength) {
    const tag = readVarint(bytes, cursor);
    cursor = tag.next;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x7n);
    if (fieldNumber <= 0) {
      throw new Error("invalid protobuf field number");
    }

    if (wireType === WIRE_VARINT) {
      const value = readVarint(bytes, cursor);
      cursor = value.next;
      fields.push({ fieldNumber, wireType, varint: value.value });
    } else if (wireType === WIRE_LENGTH_DELIMITED) {
      const length = readVarint(bytes, cursor);
      cursor = length.next;
      const end = cursor + Number(length.value);
      if (end > bytes.byteLength) {
        throw new Error("truncated protobuf length-delimited field");
      }
      fields.push({ fieldNumber, wireType, bytes: bytes.subarray(cursor, end) });
      cursor = end;
    } else if (wireType === WIRE_FIXED64) {
      if (cursor + 8 > bytes.byteLength) {
        throw new Error("truncated protobuf fixed64 field");
      }
      cursor += 8;
      fields.push({ fieldNumber, wireType });
    } else if (wireType === WIRE_FIXED32) {
      if (cursor + 4 > bytes.byteLength) {
        throw new Error("truncated protobuf fixed32 field");
      }
      cursor += 4;
      fields.push({ fieldNumber, wireType });
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }
  return fields;
}

function decodeUtf8(field: DecodedField): string {
  return field.bytes ? textDecoder.decode(field.bytes) : "";
}

export function decodeFeishuFrame(bytes: Uint8Array): FeishuFrame {
  const fields = decodeFields(bytes);
  const frame: FeishuFrame = {
    seqId: 0n,
    logId: 0n,
    service: 0,
    method: 0,
    headers: [],
  };
  for (const field of fields) {
    switch (field.fieldNumber) {
      case 1:
        frame.seqId = field.varint ?? 0n;
        break;
      case 2:
        frame.logId = field.varint ?? 0n;
        break;
      case 3:
        frame.service = Number(field.varint ?? 0n);
        break;
      case 4:
        frame.method = Number(field.varint ?? 0n);
        break;
      case 5:
        if (field.bytes) {
          frame.headers.push(decodeHeader(field.bytes));
        }
        break;
      case 6:
        frame.payloadEncoding = decodeUtf8(field);
        break;
      case 7:
        frame.payloadType = decodeUtf8(field);
        break;
      case 8:
        frame.payload = field.bytes ?? new Uint8Array();
        break;
      case 9:
        frame.logIdNew = decodeUtf8(field);
        break;
      default:
        break;
    }
  }
  return frame;
}

export function getFeishuHeader(frame: FeishuFrame, key: string): string | undefined {
  for (const header of frame.headers) {
    if (header.key === key) {
      return header.value;
    }
  }
  return undefined;
}

export function setFeishuHeader(frame: FeishuFrame, key: string, value: string): void {
  const existing = frame.headers.find((header) => header.key === key);
  if (existing) {
    existing.value = value;
    return;
  }
  frame.headers.push({ key, value });
}

export function feishuTextPayload(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

export function feishuJsonPayload(frame: FeishuFrame): unknown {
  if (!frame.payload) {
    return null;
  }
  try {
    return JSON.parse(textDecoder.decode(frame.payload)) as unknown;
  } catch {
    return null;
  }
}
