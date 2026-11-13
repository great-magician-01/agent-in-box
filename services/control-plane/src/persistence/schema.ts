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
  provisioning_profile: string | null;
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
  provisioning_state: string;
  provisioning_message: string | null;
  provisioning_started_at: string | null;
}

export interface ProjectsTable {
  id: string;
  name: string;
  description: string;
  default_vm_binding_id: string | null;
  workspace_config_json: string;
  agent_config_json: string;
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
  agent_session_ref: string | null;
  session_version: string | null;
  last_heartbeat_at: string | null;
  archive_summary: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  broker_token_id: string | null;
  provider_id: string | null;
  model_id: string | null;
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

export interface ModelProvidersTable {
  id: string;
  base_url: string;
  api: string;
  credential_provider_id: string;
  models_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ModelTokensTable {
  id: string;
  token_hash: string;
  worker_id: string;
  task_id: string | null;
  vm_id: string;
  provider_id: string;
  model: string;
  session_id: string;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface ModelRequestsTable {
  id: string;
  token_id: string | null;
  provider_id: string;
  model: string;
  worker_id: string;
  task_id: string | null;
  vm_id: string;
  status: string;
  upstream_status: number | null;
  attempts: number;
  duration_ms: number | null;
  usage_json: string | null;
  error_code: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ConversationMessagesTable {
  id: string;
  conversation_id: string;
  worker_id: string;
  task_id: string | null;
  role: string;
  mode: string;
  content: string;
  created_at: string;
}

export interface ProjectPoliciesTable {
  project_id: string;
  policy_json: string;
  updated_at: string;
}

export interface TaskExecutionStateTable {
  task_id: string;
  worker_id: string;
  vm_id: string;
  started_at: string;
  deadline_at: string;
  step_count: number;
  action_count: number;
  no_progress_streak: number;
  duplicate_streak: number;
  completion_attempts: number;
  requires_observation: number;
  last_action_signature: string | null;
  last_action_at: string | null;
  ended_at: string | null;
  outcome: string | null;
}

export interface CuaScreenshotsTable {
  id: string;
  task_id: string;
  worker_id: string;
  vm_id: string;
  kind: string;
  width: number;
  height: number;
  dpi: number | null;
  scale_factor: number | null;
  sha256: string;
  file_path: string;
  size_bytes: number;
  captured_at: string;
}

export interface CuaActionsTable {
  id: string;
  task_id: string;
  worker_id: string;
  vm_id: string;
  lease_id: string;
  action_type: string;
  action_json: string;
  source_screenshot_id: string | null;
  before_screenshot_id: string | null;
  after_screenshot_id: string | null;
  display_json: string;
  status: string;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  approval_id: string | null;
  created_at: string;
  executed_at: string | null;
  duration_ms: number | null;
}

export interface CuaApprovalsTable {
  id: string;
  task_id: string;
  worker_id: string;
  action_id: string;
  action_type: string;
  action_json: string;
  context_summary: string;
  status: string;
  requested_at: string;
  expires_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export interface HumanVerificationsTable {
  id: string;
  task_id: string;
  worker_id: string;
  vm_id: string;
  reason: string;
  screenshot_id: string;
  status: string;
  requested_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export interface CuaTokensTable {
  id: string;
  token_hash: string;
  worker_id: string;
  vm_id: string;
  session_id: string;
  task_id: string | null;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface WorkerArchivesTable {
  id: string;
  worker_id: string;
  project_id: string;
  vm_id: string;
  conversation_id: string;
  archive_ref: string;
  engine_type: string;
  engine_version: string;
  session_version: string;
  summary: string;
  restore_point_json: string | null;
  artifacts_json: string;
  source: string;
  status: string;
  created_at: string;
  restored_at: string | null;
}

export interface WorkerResumeContextsTable {
  id: string;
  worker_id: string;
  archive_id: string | null;
  restore_mode: string;
  screenshot_path: string | null;
  screenshot_sha256: string | null;
  screenshot_width: number | null;
  screenshot_height: number | null;
  environment_json: string;
  created_at: string;
}

export interface WorkerInputsTable {
  id: string;
  worker_id: string;
  kind: string;
  content: string;
  status: string;
  created_at: string;
  delivered_at: string | null;
}

export interface RouterSessionsTable {
  conversation_id: string;
  status: string;
  session_ref: string | null;
  engine_type: string;
  engine_version: string;
  session_version: string;
  provider_id: string | null;
  model_id: string | null;
  tool_token_hash: string | null;
  tool_token_expires_at: string | null;
  last_active_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RouterMessagesTable {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface RouterToolCallsTable {
  id: string;
  conversation_id: string;
  tool_name: string;
  args_json: string;
  result_json: string | null;
  status: string;
  error_code: string | null;
  error_message: string | null;
  duration_ms: number;
  created_at: string;
}

export interface RouterModelTokensTable {
  id: string;
  token_hash: string;
  conversation_id: string;
  provider_id: string;
  model: string;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface VmSnapshotsTable {
  id: string;
  vm_id: string;
  tag: string;
  label: string;
  status: string;
  affected_projects_json: string;
  size_bytes: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  restored_at: string | null;
}

export interface ProjectBackupsTable {
  id: string;
  project_id: string;
  label: string;
  status: string;
  artifact_snapshot_json: string;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  restored_at: string | null;
}

export interface ProjectBackupBindingsTable {
  id: string;
  backup_id: string;
  binding_id: string;
  vm_id: string;
  vm_name: string;
  guest_workspace_path: string;
  file_path: string | null;
  sha256: string | null;
  size_bytes: number | null;
  file_count: number | null;
  status: string;
  error_message: string | null;
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

export interface BotAccountsTable {
  id: string;
  platform: string;
  name: string;
  enabled: number;
  app_id: string;
  credential_provider_id: string;
  config_json: string;
  device_id: string | null;
  state: string;
  last_connected_at: string | null;
  last_error: string | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BotIdentitiesTable {
  id: string;
  platform: string;
  platform_user_id: string;
  display_name: string;
  role: string;
  bound: number;
  local_user_id: string | null;
  created_at: string;
  last_seen_at: string;
}

export interface BotChatsTable {
  id: string;
  platform: string;
  conversation_id: string;
  kind: string;
  title: string;
  allowed: number;
  project_id: string | null;
  last_message_id: string | null;
  created_at: string;
  last_seen_at: string;
}

export interface BotEventsTable {
  dedup_key: string;
  account_id: string;
  platform: string;
  event_id: string;
  platform_user_id: string;
  conversation_id: string;
  text: string;
  received_at: string;
  raw_json: string;
  state: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
}

export interface BotOutboundTable {
  id: string;
  account_id: string;
  platform: string;
  conversation_id: string;
  text: string;
  kind: string;
  ref_id: string | null;
  dedupe_key: string;
  reply_to_message_id: string | null;
  state: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface BotTurnsTable {
  id: string;
  account_id: string;
  platform: string;
  platform_conversation_id: string;
  local_conversation_id: string;
  user_text: string;
  status: string;
  assistant_text: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface BotTaskLinksTable {
  task_id: string;
  turn_id: string;
  account_id: string;
  platform: string;
  platform_conversation_id: string;
  created_at: string;
}

export interface BotApprovalLinksTable {
  approval_id: string;
  task_id: string;
  account_id: string;
  platform: string;
  platform_conversation_id: string;
  created_at: string;
}

export interface BotAccessCodesTable {
  id: string;
  code_hash: string;
  role: string;
  expires_at: string;
  created_at: string;
  used_at: string | null;
  used_by: string | null;
}

export interface BotConfirmationsTable {
  id: string;
  platform: string;
  conversation_id: string;
  platform_user_id: string;
  action: string;
  ref_id: string;
  expires_at: string;
  created_at: string;
}

export interface AuthSessionsTable {
  /** SHA-256 of the session cookie value; the raw token is never stored. */
  id: string;
  user_id: string;
  role: string;
  csrf_token: string;
  label: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export interface NotificationsTable {
  id: string;
  source_event_id: number | null;
  kind: string;
  severity: string;
  title: string;
  body: string;
  project_id: string | null;
  task_id: string | null;
  vm_id: string | null;
  worker_id: string | null;
  created_at: string;
  read_at: string | null;
  dismissed_at: string | null;
}

export interface InboxFilesTable {
  id: string;
  original_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  stored_path: string;
  project_id: string | null;
  created_at: string;
  deleted_at: string | null;
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
  model_providers: ModelProvidersTable;
  model_tokens: ModelTokensTable;
  model_requests: ModelRequestsTable;
  conversation_messages: ConversationMessagesTable;
  project_policies: ProjectPoliciesTable;
  task_execution_state: TaskExecutionStateTable;
  cua_screenshots: CuaScreenshotsTable;
  cua_actions: CuaActionsTable;
  cua_approvals: CuaApprovalsTable;
  human_verifications: HumanVerificationsTable;
  cua_tokens: CuaTokensTable;
  worker_archives: WorkerArchivesTable;
  worker_resume_contexts: WorkerResumeContextsTable;
  worker_inputs: WorkerInputsTable;
  router_sessions: RouterSessionsTable;
  router_messages: RouterMessagesTable;
  router_tool_calls: RouterToolCallsTable;
  router_model_tokens: RouterModelTokensTable;
  vm_snapshots: VmSnapshotsTable;
  project_backups: ProjectBackupsTable;
  project_backup_bindings: ProjectBackupBindingsTable;
  bot_accounts: BotAccountsTable;
  bot_identities: BotIdentitiesTable;
  bot_chats: BotChatsTable;
  bot_events: BotEventsTable;
  bot_outbound: BotOutboundTable;
  bot_turns: BotTurnsTable;
  bot_task_links: BotTaskLinksTable;
  bot_approval_links: BotApprovalLinksTable;
  bot_access_codes: BotAccessCodesTable;
  bot_confirmations: BotConfirmationsTable;
  auth_sessions: AuthSessionsTable;
  notifications: NotificationsTable;
  inbox_files: InboxFilesTable;
}
