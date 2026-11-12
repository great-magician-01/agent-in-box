import express, { type NextFunction, type Request, type Response } from "express";

/** The one route whose body is the uploaded file itself, not a JSON envelope. */
export const RAW_UPLOAD_PATH = "/api/v1/inbox/upload";

/**
 * Registers the same JSON/urlencoded parsers Nest installs by default, except
 * that the raw inbox upload is left untouched so its controller can stream the
 * request. NestFactory must be created with `bodyParser: false`.
 */
export function installBodyParsers(app: {
  use(
    ...handlers: Array<(request: Request, response: Response, next: NextFunction) => void>
  ): unknown;
}): void {
  const jsonParser = express.json({ limit: "100kb" });
  const urlencodedParser = express.urlencoded({ extended: true, limit: "100kb" });
  const isRawUpload = (request: Request): boolean => request.path === RAW_UPLOAD_PATH;

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (isRawUpload(request)) {
      next();
      return;
    }
    jsonParser(request, response, next);
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (isRawUpload(request)) {
      next();
      return;
    }
    urlencodedParser(request, response, next);
  });
}
