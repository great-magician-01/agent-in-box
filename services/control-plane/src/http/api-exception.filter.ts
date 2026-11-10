import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Response } from "express";
import type { ApiError, ApiErrorCode } from "@agent-in-box/protocol";
import { PersistenceError } from "../persistence/errors";

function statusForCode(code: ApiErrorCode): number {
  switch (code) {
    case "bad_request":
    case "validation_failed":
      return HttpStatus.BAD_REQUEST;
    case "unauthorized":
      return HttpStatus.UNAUTHORIZED;
    case "forbidden":
      return HttpStatus.FORBIDDEN;
    case "not_found":
      return HttpStatus.NOT_FOUND;
    case "conflict":
    case "idempotency_conflict":
    case "lease_conflict":
      return HttpStatus.CONFLICT;
    case "rate_limited":
      return HttpStatus.TOO_MANY_REQUESTS;
    case "unavailable":
      return HttpStatus.SERVICE_UNAVAILABLE;
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof PersistenceError) {
      const error: ApiError = {
        code: exception.code,
        message: exception.message,
        ...(exception.details !== undefined ? { details: exception.details } : {}),
      };
      response.status(statusForCode(exception.code)).json({ ok: false, error });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === "string"
          ? body
          : typeof body === "object" && body !== null && "message" in body
            ? Array.isArray((body as { message: unknown }).message)
              ? (body as { message: unknown[] }).message.join("; ")
              : String((body as { message: unknown }).message)
            : exception.message;
      const error: ApiError = {
        code: status === 400 ? "bad_request" : status === 404 ? "not_found" : "internal_error",
        message,
      };
      response.status(status).json({ ok: false, error });
      return;
    }

    this.logger.error(
      "Unhandled control-plane error",
      exception instanceof Error ? exception.stack : String(exception),
    );
    const error: ApiError = {
      code: "internal_error",
      message: exception instanceof Error ? exception.message : "内部错误",
    };
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ ok: false, error });
  }
}
