import Database from 'better-sqlite3';
import { Issue, IssueComment, IssueStatus, IssueStore, IssueUpdate } from '../interfaces/storage.interface';

// Author of the automatic "reopened" comment — not a real viewer.
export const SYSTEM_AUTHOR = 'Wolter';

interface IssueRow {
  id: number;
  fingerprint: string;
  status: IssueStatus;
  priority: Issue['priority'];
  assignee: string | null;
  first_seen: number;
  last_seen: number;
  resolved_at: number | null;
  updated_at: number;
}

function toIssue(r: IssueRow): Issue {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    status: r.status,
    priority: r.priority,
    assignee: r.assignee,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    resolvedAt: r.resolved_at,
    updatedAt: r.updated_at,
  };
}

// Issues outlive the metrics they were derived from: retention and size
// pruning never touch these tables, so triage state (status, assignee,
// comments) survives even after a group's last metric row ages out.
export class SqliteIssueStore implements IssueStore {
  constructor(
    private readonly db: Database.Database,
    private readonly issuesTable: string,
    private readonly commentsTable: string,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${issuesTable} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        priority TEXT,
        assignee TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        resolved_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${issuesTable}_status ON ${issuesTable}(status);
      CREATE TABLE IF NOT EXISTS ${commentsTable} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL REFERENCES ${issuesTable}(id),
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${commentsTable}_issue_id ON ${commentsTable}(issue_id);
    `);
  }

  // Read-check-write in one transaction, so a resolve landing between the
  // read and the write can't be lost or misread.
  touch(fingerprint: string, seenAt: number): void {
    this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM ${this.issuesTable} WHERE fingerprint = ?`).get(fingerprint) as IssueRow | undefined;
      if (!row) {
        this.db
          .prepare(`INSERT INTO ${this.issuesTable} (fingerprint, status, first_seen, last_seen, updated_at) VALUES (?, 'open', ?, ?, ?)`)
          .run(fingerprint, seenAt, seenAt, seenAt);
        return;
      }
      // Regression: it happened again after someone marked it resolved.
      if (row.status === 'resolved' && row.resolved_at !== null && seenAt > row.resolved_at) {
        this.db
          .prepare(`UPDATE ${this.issuesTable} SET status = 'open', resolved_at = NULL, last_seen = MAX(last_seen, ?), updated_at = ? WHERE id = ?`)
          .run(seenAt, seenAt, row.id);
        this.insertComment(row.id, SYSTEM_AUTHOR, 'Reopened automatically: this error occurred again after it was resolved.', seenAt);
        return;
      }
      if (seenAt > row.last_seen) {
        this.db.prepare(`UPDATE ${this.issuesTable} SET last_seen = ? WHERE id = ?`).run(seenAt, row.id);
      }
    })();
  }

  list(status?: IssueStatus): Issue[] {
    const rows = status
      ? this.db.prepare(`SELECT * FROM ${this.issuesTable} WHERE status = ? ORDER BY last_seen DESC`).all(status)
      : this.db.prepare(`SELECT * FROM ${this.issuesTable} ORDER BY last_seen DESC`).all();
    return (rows as IssueRow[]).map(toIssue);
  }

  get(id: number): (Issue & { comments: IssueComment[] }) | undefined {
    const row = this.db.prepare(`SELECT * FROM ${this.issuesTable} WHERE id = ?`).get(id) as IssueRow | undefined;
    if (!row) return undefined;
    const comments = this.db
      .prepare(`SELECT id, issue_id AS issueId, author, body, created_at AS createdAt FROM ${this.commentsTable} WHERE issue_id = ? ORDER BY created_at ASC, id ASC`)
      .all(id) as IssueComment[];
    return { ...toIssue(row), comments };
  }

  update(id: number, update: IssueUpdate, now: number): Issue | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM ${this.issuesTable} WHERE id = ?`).get(id) as IssueRow | undefined;
      if (!row) return undefined;
      const status = update.status ?? row.status;
      // resolvedAt tracks only the current resolution: set when it becomes
      // resolved, cleared when it leaves that state (reopen/ignore).
      const resolvedAt = status === 'resolved' ? (row.status === 'resolved' ? row.resolved_at : now) : null;
      const priority = update.priority === undefined ? row.priority : update.priority;
      const assignee = update.assignee === undefined ? row.assignee : update.assignee;
      this.db
        .prepare(`UPDATE ${this.issuesTable} SET status = ?, priority = ?, assignee = ?, resolved_at = ?, updated_at = ? WHERE id = ?`)
        .run(status, priority, assignee, resolvedAt, now, id);
      return toIssue({ ...row, status, priority, assignee, resolved_at: resolvedAt, updated_at: now });
    })();
  }

  addComment(id: number, author: string, body: string, now: number): IssueComment | undefined {
    const exists = this.db.prepare(`SELECT 1 FROM ${this.issuesTable} WHERE id = ?`).get(id);
    if (!exists) return undefined;
    return this.insertComment(id, author, body, now);
  }

  private insertComment(issueId: number, author: string, body: string, now: number): IssueComment {
    const result = this.db
      .prepare(`INSERT INTO ${this.commentsTable} (issue_id, author, body, created_at) VALUES (?, ?, ?, ?)`)
      .run(issueId, author, body, now);
    return { id: Number(result.lastInsertRowid), issueId, author, body, createdAt: now };
  }
}
