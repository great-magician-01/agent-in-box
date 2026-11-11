import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import type { NotificationCenterView, NotificationRecord } from "@agent-in-box/protocol";
import { NotificationsService } from "./notifications.service";

@Controller("/api/v1/notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  center(
    @Query("limit") limit?: string,
    @Query("unreadOnly") unreadOnly?: string,
  ): Promise<NotificationCenterView> {
    const parsed = limit === undefined ? 60 : Number(limit);
    return this.notifications.center({
      limit: Number.isFinite(parsed) ? parsed : 60,
      unreadOnly: unreadOnly === "true" || unreadOnly === "1",
    });
  }

  @Post("read-all")
  @HttpCode(HttpStatus.OK)
  async markAllRead(): Promise<NotificationCenterView> {
    await this.notifications.markAllRead();
    return this.notifications.center();
  }

  @Post("reconcile")
  @HttpCode(HttpStatus.OK)
  async reconcile(): Promise<{ inserted: number } & NotificationCenterView> {
    const inserted = await this.notifications.reconcile();
    return { inserted, ...(await this.notifications.center()) };
  }

  @Post(":id/read")
  @HttpCode(HttpStatus.OK)
  markRead(@Param("id") id: string): Promise<NotificationRecord> {
    return this.notifications.markRead(id);
  }

  @Post(":id/dismiss")
  @HttpCode(HttpStatus.OK)
  dismiss(@Param("id") id: string): Promise<NotificationRecord> {
    return this.notifications.dismiss(id);
  }
}
