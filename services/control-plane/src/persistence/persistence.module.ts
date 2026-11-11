import { Module, type Provider } from "@nestjs/common";
import { DatabaseService } from "./database.service";
import { KYSELY } from "./tokens";
import { CatalogRepository } from "./repositories/catalog-repository";
import { TaskRepository } from "./repositories/task-repository";
import { WorkerArchiveRepository } from "./repositories/worker-archive-repository";
import { WorkerRepository } from "./repositories/worker-repository";
import { LeaseRepository } from "./repositories/lease-repository";
import { OutboxRepository } from "./repositories/outbox-repository";
import { EventDedupRepository } from "./repositories/event-dedup-repository";
import { TaskService, TASK_SERVICE_OPTIONS } from "./services/task-service";
import { LeaseService } from "./services/lease-service";

const kyselyProvider: Provider = {
  provide: KYSELY,
  useFactory: (database: DatabaseService) => database.db,
  inject: [DatabaseService],
};

@Module({
  providers: [
    DatabaseService,
    kyselyProvider,
    CatalogRepository,
    TaskRepository,
    WorkerRepository,
    WorkerArchiveRepository,
    LeaseRepository,
    OutboxRepository,
    EventDedupRepository,
    {
      provide: TASK_SERVICE_OPTIONS,
      useFactory: (database: DatabaseService) => ({ artifactRoot: database.layout.artifacts }),
      inject: [DatabaseService],
    },
    TaskService,
    LeaseService,
  ],
  exports: [
    DatabaseService,
    KYSELY,
    CatalogRepository,
    TaskRepository,
    WorkerRepository,
    WorkerArchiveRepository,
    LeaseRepository,
    OutboxRepository,
    EventDedupRepository,
    TaskService,
    LeaseService,
  ],
})
export class PersistenceModule {}
