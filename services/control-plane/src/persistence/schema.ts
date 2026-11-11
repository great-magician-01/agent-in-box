import type { Generated } from "kysely";

export interface ImagesTable {
  id: string;
  name: string;
  os_family: string;
  os_version: string;
  architecture: string;
  version: string;
  status: string;
  size_bytes: number;
  checksum: string;
  local_path: string | null;
  created_at: string;
  verified_at: string | null;
  source_url: string;
  file_name: string;
  downloaded_bytes: number;
  error_code: string | null;
  error_message: string | null;
  updated_at: string;
  seed_local_path: string | null;
  manifest_json: string;
}

export interface VmInstancesTable {
  id: string;
  name: string;
  image_id: string;
  os_family: string;
  cpu_count: number;
  memory_bytes: number;
  disk_bytes: number;
  storage_root: string;
  power_state: string;
  guest_health: string;
  created_at: string;
  last_started_at: string | null;
}

export interface ProjectsTable {
  id: string;
  name: string;
  description: string;
  default_vm_binding_id: string | null;
  workspace_config_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ProjectVmBindingsTable {
  id: string;
  project_id: string;
  vm_id: string;
  guest_workspace_path: string;
  is_primary: number;
  created_at: string;
}

export interface ConversationsTable {
  id: string;
  kind: string;
  project_id: string | null;
  title: string;
  created_at: string;
  last_message_at: string;
}

export interface WorkersTable {
  id: string;
  project_id: string;
  vm_id: string;
  conversation_id: string;
  engine_type: string;
  engine_version: string;
  status: string;
  current_task_id: string | null;
  capability_set: string;
  created_at: string;
  last_active_at: string;
  archived_at: string | null;
}

export interface TasksTable {
  id: string;
  project_id: string;
  vm_id: string;
  origin_conversation_id: string;
  assigned_worker_id: string | null;
  parent_task_id: string | null;
  objective: string;
  status: string;
  priority: number;
  attempt_count: number;
  latest_summary: string | null;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface TaskEventsTable {
  id: Generated<number>;
  task_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

export interface TaskDependenciesTable {
  task_id: string;
  dependency_task_id: string;
  created_at: string;
}

export interface TaskArtifactsTable {
  id: string;
  project_id: string;
  task_id: string;
  name: string;
  relative_path: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
  verified_at: string | null;
}

export interface ProjectActivitiesTable {
  id: Generated<number>;
  project_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

export interface OutboxTable {
  id: Generated<number>;
  topic: string;
  payload_json: string;
  created_at: string;
  published_at: string | null;
  attempts: number;
  last_error: string | null;
}

export interface VmLeasesTable {
  id: string;
  vm_id: string;
  owner: string;
  task_id: string | null;
  acquired_at: string;
  expires_at: string;
}

export interface ProcessedEventsTable {
  dedup_key: string;
  processed_at: string;
}

export interface IdempotencyKeysTable {
  key: string;
  task_id: string;
  request_hash: string;
  created_at: string;
}

export interface SchemaMigrationsTable {
  id: string;
  applied_at: string;
}

export interface AppSettingsTable {
  key: string;
  value_json: string;
  updated_at: string;
}

export interface LocalUsersTable {
  id: string;
  display_name: string;
  role: string;
  created_at: string;
  last_active_at: string;
}

export interface StorageMigrationsTable {
  id: string;
  from_root: string;
  to_root: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  error: string | null;
  files_copied: number;
  bytes_copied: number;
}

export interface DatabaseSchema {
  schema_migrations: SchemaMigrationsTable;
  images: ImagesTable;
  vm_instances: VmInstancesTable;
  projects: ProjectsTable;
  project_vm_bindings: ProjectVmBindingsTable;
  conversations: ConversationsTable;
  workers: WorkersTable;
  tasks: TasksTable;
  task_events: TaskEventsTable;
  task_dependencies: TaskDependenciesTable;
  task_artifacts: TaskArtifactsTable;
  project_activities: ProjectActivitiesTable;
  outbox: OutboxTable;
  vm_leases: VmLeasesTable;
  processed_events: ProcessedEventsTable;
  idempotency_keys: IdempotencyKeysTable;
  app_settings: AppSettingsTable;
  local_users: LocalUsersTable;
  storage_migrations: StorageMigrationsTable;
}
