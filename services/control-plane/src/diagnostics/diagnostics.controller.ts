import { Controller, Get, Header } from "@nestjs/common";
import type { DiagnosticsReport } from "@agent-in-box/protocol";
import { DiagnosticsService } from "./diagnostics.service";

@Controller("api/v1/diagnostics")
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  report(): Promise<DiagnosticsReport> {
    return this.diagnostics.report();
  }
}
