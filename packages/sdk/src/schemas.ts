/**
 * Response shapes of the backupd API. Only the fields this SDK uses are
 * listed; anything else the API sends is ignored, so new fields never break
 * an older SDK. Timestamps are ISO-8601 strings.
 */
import { Schema } from "effect";

const Iso = Schema.String;
const NullableIso = Schema.NullOr(Schema.String);
const NullableNumber = Schema.NullOr(Schema.Number);
const NullableString = Schema.NullOr(Schema.String);

export const Engine = Schema.Literals(["postgres", "mysql", "mongodb", "convex"]);
export type Engine = typeof Engine.Type;

export const ScheduleId = Schema.Literals(["6h", "12h", "24h"]);
export type ScheduleId = typeof ScheduleId.Type;

export const DatabaseStatus = Schema.Literals(["active", "paused"]);
export type DatabaseStatus = typeof DatabaseStatus.Type;

export const RunStatus = Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"]);
export type RunStatus = typeof RunStatus.Type;

export const VerificationStatus = Schema.Literals([
  "unverified",
  "verifying",
  "verified",
  "failed",
]);
export type VerificationStatus = typeof VerificationStatus.Type;

/* ------------------------------------------------------------------ */
/* Account and workspaces                                              */
/* ------------------------------------------------------------------ */

export const Me = Schema.Struct({
  email: Schema.String,
  id: Schema.String,
  name: Schema.String,
});
export type Me = typeof Me.Type;

export const Workspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  region: Schema.optionalKey(NullableString),
  role: Schema.String,
  slug: Schema.String,
});
export type Workspace = typeof Workspace.Type;

/* ------------------------------------------------------------------ */
/* Databases                                                           */
/* ------------------------------------------------------------------ */

const LastRun = Schema.Struct({
  startedAt: Iso,
  status: RunStatus,
  verificationStatus: VerificationStatus,
});

export const Database = Schema.Struct({
  createdAt: Iso,
  engine: Engine,
  engineVersion: NullableString,
  fileCount: Schema.Number,
  host: Schema.String,
  id: Schema.String,
  lastBackup: Schema.NullOr(LastRun),
  lastBackupAt: NullableIso,
  name: Schema.String,
  retentionDays: Schema.Number,
  schedule: ScheduleId,
  scheduleHour: Schema.Number,
  status: DatabaseStatus,
  /** Stored (compressed and encrypted) bytes of all its backups. */
  totalBytes: Schema.Number,
  verifiedCount: Schema.Number,
});
export type Database = typeof Database.Type;

export const DatabaseDetail = Schema.Struct({
  canManage: Schema.Boolean,
  createdAt: Iso,
  effectiveSchedule: ScheduleId,
  engine: Engine,
  engineVersion: NullableString,
  host: Schema.String,
  id: Schema.String,
  lastBackup: Schema.NullOr(Schema.Struct({ ...LastRun.fields, id: Schema.String })),
  name: Schema.String,
  nextRunAt: NullableIso,
  retentionDays: Schema.Number,
  schedule: ScheduleId,
  scheduleHour: Schema.Number,
  stats: Schema.Struct({
    avgDurationMs: Schema.Number,
    fileCount: Schema.Number,
    successRate: NullableNumber,
    totalBytes: Schema.Number,
    verifiedRate: NullableNumber,
  }),
  status: DatabaseStatus,
});
export type DatabaseDetail = typeof DatabaseDetail.Type;

export const CreatedDatabase = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  nextRunAt: NullableIso,
});
export type CreatedDatabase = typeof CreatedDatabase.Type;

export const DatabaseChange = Schema.Struct({
  name: NullableString,
  ok: Schema.Boolean,
});

export const ConnectionTest = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    probe: Schema.Struct({
      engineVersion: Schema.String,
      sizeBytes: NullableNumber,
    }),
  }),
  Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    ok: Schema.Literal(false),
    retryable: Schema.Boolean,
  }),
]);
export type ConnectionTest = typeof ConnectionTest.Type;

/* ------------------------------------------------------------------ */
/* Backups                                                             */
/* ------------------------------------------------------------------ */

const VerificationDetails = Schema.Struct({
  durationMs: Schema.Number,
  mismatches: Schema.Array(
    Schema.Struct({ actual: Schema.Number, expected: Schema.Number, table: Schema.String }),
  ),
  rowsChecked: Schema.Number,
  sandbox: Schema.String,
  tablesChecked: Schema.Number,
});

export const RestoreRun = Schema.Struct({
  createdAt: Iso,
  error: NullableString,
  finishedAt: NullableIso,
  id: Schema.String,
  rowsRestored: Schema.Number,
  status: RunStatus,
  tablesRestored: Schema.Number,
  target: Schema.Literals(["original", "custom"]),
  targetLabel: Schema.String,
});
export type RestoreRun = typeof RestoreRun.Type;

const BackupCommon = {
  databaseId: Schema.String,
  deletedAt: NullableIso,
  durationMs: NullableNumber,
  errorMessage: NullableString,
  fileName: Schema.String,
  finishedAt: NullableIso,
  hasFile: Schema.Boolean,
  id: Schema.String,
  /** What a running backup is doing: connecting, dumping, uploading, verifying… */
  phase: NullableString,
  /** Size of the dump before compression. */
  plaintextSizeBytes: NullableNumber,
  /** Stored size, compressed and encrypted. */
  sizeBytes: NullableNumber,
  startedAt: Iso,
  status: RunStatus,
  trigger: Schema.Literals(["scheduled", "manual"]),
  /** `integrity` (decrypt and checksum) or `restore` (restored in a sandbox). */
  verificationLevel: NullableString,
  verificationStatus: VerificationStatus,
  verifiedAgainst: NullableString,
  verifiedAt: NullableIso,
};

export const BackupSummary = Schema.Struct({
  ...BackupCommon,
  databaseEngine: Engine,
  databaseName: Schema.String,
});
export type BackupSummary = typeof BackupSummary.Type;

export const BackupPage = Schema.Struct({
  items: Schema.Array(BackupSummary),
  total: Schema.Number,
});
export type BackupPage = typeof BackupPage.Type;

export const Backup = Schema.Struct({
  ...BackupCommon,
  checksum: NullableString,
  database: Schema.Struct({
    engine: Engine,
    engineVersion: NullableString,
    host: Schema.String,
    id: Schema.String,
    name: Schema.String,
  }),
  encryption: Schema.NullOr(
    Schema.Struct({ algorithm: Schema.String, recipients: Schema.Array(Schema.String) }),
  ),
  format: NullableString,
  /** What the engine's dump tool recorded. `oplog` is set for MongoDB replica-set dumps. */
  manifest: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ oplog: Schema.optionalKey(Schema.Boolean) })),
  ),
  restores: Schema.Array(RestoreRun),
  verificationDetails: Schema.NullOr(VerificationDetails),
});
export type Backup = typeof Backup.Type;

export const ManualQuota = Schema.Struct({
  limit: Schema.Number,
  remaining: Schema.Number,
  resetAt: NullableIso,
});
export type ManualQuota = typeof ManualQuota.Type;

export const TriggeredBackup = Schema.Struct({
  backupId: Schema.String,
  databaseName: Schema.String,
  quota: Schema.Struct({ remaining: Schema.Number, resetAt: NullableIso }),
});
export type TriggeredBackup = typeof TriggeredBackup.Type;

export const CancelledBackup = Schema.Struct({
  databaseName: Schema.String,
  fileName: Schema.String,
});

/* ------------------------------------------------------------------ */
/* Restores                                                            */
/* ------------------------------------------------------------------ */

export const CreatedRestore = Schema.Struct({ restoreId: Schema.String });

export const RestoreSummary = Schema.Struct({
  backupId: Schema.String,
  createdAt: Iso,
  error: NullableString,
  fileName: Schema.String,
  finishedAt: NullableIso,
  id: Schema.String,
  rowsRestored: Schema.Number,
  status: RunStatus,
  tablesRestored: Schema.Number,
  target: Schema.Literals(["original", "custom"]),
  targetLabel: Schema.String,
});
export type RestoreSummary = typeof RestoreSummary.Type;

/* ------------------------------------------------------------------ */
/* Encryption                                                          */
/* ------------------------------------------------------------------ */

export const EncryptionKey = Schema.Struct({
  createdAt: Iso,
  fingerprint: Schema.String,
  id: Schema.String,
  label: Schema.String,
  recipient: Schema.String,
});
export type EncryptionKey = typeof EncryptionKey.Type;

export const Encryption = Schema.Struct({
  canManage: Schema.Boolean,
  maxRecipients: Schema.Number,
  recipients: Schema.Array(EncryptionKey),
  /** backupd's own key for the workspace, used for restore tests and restores. */
  serviceRecipient: Schema.String,
});
export type Encryption = typeof Encryption.Type;

export const AddedKey = Schema.Struct({ fingerprint: Schema.String, id: Schema.String });
export const RevokedKey = Schema.Struct({ fingerprint: Schema.String, label: Schema.String });

export const Ok = Schema.Struct({ ok: Schema.Boolean });
