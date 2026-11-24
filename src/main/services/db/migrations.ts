import { DatabaseSync } from 'node:sqlite'
import type { Row } from './mappers'

export function openDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath)
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  return database
}

export function migrateDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vault_registry (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      connected_at TEXT NOT NULL,
      last_indexed_at TEXT NOT NULL,
      question_count INTEGER NOT NULL DEFAULT 0,
      document_count INTEGER NOT NULL DEFAULT 0,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      is_builtin INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS vault_snapshots (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      question_count INTEGER NOT NULL,
      document_count INTEGER NOT NULL,
      payload BLOB NOT NULL,
      FOREIGN KEY(vault_id) REFERENCES vault_registry(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_vault_snapshots_time ON vault_snapshots(vault_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      category TEXT NOT NULL,
      type TEXT NOT NULL,
      stem TEXT NOT NULL,
      options_json TEXT NOT NULL,
      answer_json TEXT NOT NULL,
      explanation TEXT NOT NULL,
      difficulty INTEGER NOT NULL,
      source TEXT NOT NULL,
      year INTEGER,
      region TEXT,
      paper TEXT,
      material TEXT,
      content_version TEXT,
      tags_json TEXT NOT NULL,
      file_path TEXT,
      content_hash TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      FOREIGN KEY(vault_id) REFERENCES vault_registry(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_questions_subject_category ON questions(subject, category);
    CREATE INDEX IF NOT EXISTS idx_questions_vault ON questions(vault_id);
    CREATE INDEX IF NOT EXISTS idx_questions_vault_subject_region_year ON questions(vault_id, subject, region, year);
    CREATE INDEX IF NOT EXISTS idx_questions_vault_subject_paper ON questions(vault_id, subject, paper);
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      file_path TEXT,
      indexed_at TEXT NOT NULL,
      FOREIGN KEY(vault_id) REFERENCES vault_registry(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_documents_kind_subject ON documents(kind, subject);
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL,
      answer_json TEXT NOT NULL,
      correct INTEGER NOT NULL,
      duration_seconds INTEGER NOT NULL,
      mode TEXT NOT NULL,
      session_id TEXT,
      wrong_cause TEXT,
      question_snapshot_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_question_time ON attempts(question_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_attempts_created ON attempts(created_at DESC);
    CREATE TABLE IF NOT EXISTS wrong_questions (
      question_id TEXT PRIMARY KEY,
      wrong_count INTEGER NOT NULL DEFAULT 0,
      correct_streak INTEGER NOT NULL DEFAULT 0,
      mastered INTEGER NOT NULL DEFAULT 0,
      last_wrong_cause TEXT,
      first_wrong_at TEXT NOT NULL,
      last_attempt_at TEXT NOT NULL,
      FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS review_tasks (
      question_id TEXT PRIMARY KEY,
      due_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_review_due ON review_tasks(due_at, completed_at);
    CREATE TABLE IF NOT EXISTS favorites (
      question_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS user_notes (
      question_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS learning_sessions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS exam_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subject TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      duration_minutes INTEGER NOT NULL,
      question_ids_json TEXT NOT NULL,
      question_snapshots_json TEXT NOT NULL DEFAULT '{}',
      answers_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      score REAL,
      correct_count INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_exams_status_time ON exam_sessions(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS constructed_drafts (
      id TEXT PRIMARY KEY,
      prompt_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS constructed_attempts (
      id TEXT PRIMARY KEY,
      prompt_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      evaluation_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_plans (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plan_completions (
      plan_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      completed INTEGER NOT NULL,
      completed_at TEXT NOT NULL,
      PRIMARY KEY(plan_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS ai_config (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      payload_json TEXT NOT NULL,
      encrypted_key TEXT,
      verified INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vlm_config (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      payload_json TEXT NOT NULL,
      encrypted_key TEXT,
      verified INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_training_attempts (
      id TEXT PRIMARY KEY,
      source_question_id TEXT NOT NULL,
      variant_json TEXT NOT NULL,
      user_answer_json TEXT NOT NULL,
      correct INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS integrations (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      question_id TEXT,
      messages_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_conversations_updated ON ai_conversations(updated_at DESC);
  `)
  const examColumns = db.prepare('PRAGMA table_info(exam_sessions)').all() as Row[]
  if (!examColumns.some((column) => String(column.name) === 'question_snapshots_json')) {
    db.exec(
      "ALTER TABLE exam_sessions ADD COLUMN question_snapshots_json TEXT NOT NULL DEFAULT '{}'"
    )
  }
  const questionColumns = db.prepare('PRAGMA table_info(questions)').all() as Row[]
  for (const [name, type] of [
    ['region', 'TEXT'],
    ['paper', 'TEXT'],
    ['material', 'TEXT'],
    ['content_version', 'TEXT'],
    ['papers_json', 'TEXT'],
    ['group_id', 'TEXT'],
    ['group_order', 'INTEGER'],
    ['file_mtime_ms', 'REAL'],
    ['file_size', 'INTEGER']
  ]) {
    if (!questionColumns.some((column) => String(column.name) === name))
      db.exec(`ALTER TABLE questions ADD COLUMN ${name} ${type}`)
  }
  db.prepare('INSERT OR IGNORE INTO app_meta(key, value) VALUES (?, ?)').run('schema_version', '1')
}
