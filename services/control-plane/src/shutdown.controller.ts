import { Controller, HttpCode, Post, Res } from "@nestjs/common";
import type { Response } from "express";

/**
 * Authenticated administrative shutdown for the local desktop shell.
 *
 * The global AuthGuard requires the installation access key (Bearer) or a
 * logged-in session with CSRF, so no other local process can stop the service.
 * The response is written before the application starts closing, letting the
 * caller distinguish "accepted" from "the socket died".
 */
@Controller()
export class ShutdownController {
  private stop: (() => void) | null = null;

  /** main.ts installs the actual shutdown callback after app.listen(). */
  onShutdown(stop: () => void): void {
    this.stop = stop;
  }

  @Post("api/v1/shutdown")
  @HttpCode(202)
  shutdown(@Res() response: Response): void {
    response.status(202).json({ ok: true, stopping: true });
    const stop = this.stop;
    if (!stop) return;
    // Let Express flush the accepted response before the listener closes.
    setImmediate(stop);
  }
}
