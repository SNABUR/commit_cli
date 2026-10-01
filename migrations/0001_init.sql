CREATE TABLE IF NOT EXISTS commit_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    installation_id TEXT NOT NULL,
    repository TEXT NOT NULL,
    message TEXT NOT NULL,
    branch TEXT,
    commit_hash TEXT,
    author TEXT,
    platform TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commits_repo ON commit_messages(repository);
CREATE INDEX IF NOT EXISTS idx_commits_created_at ON commit_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_commits_installation ON commit_messages(installation_id);
