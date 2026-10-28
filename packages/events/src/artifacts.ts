import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Clock, IdGenerator } from '@friday/core';
import type { SqlDatabase } from '@friday/db';
import { FridayError } from '@friday/protocol';
import type { Redactor } from './redaction.js';

export interface ArtifactRecord {
  artifact_id: string;
  project_id: string;
  kind: string;
  /** Relative to the artifacts directory, forward slashes. */
  path: string;
  sha256: string;
  bytes: number;
  created_at: string;
}

/**
 * Stores large outputs (test logs, tool output, diffs) as files under `.friday/artifacts/`,
 * referenced from events as `artifact:<id>` instead of being stuffed into payloads (plan B23).
 * Text is redacted before it is written.
 */
export class ArtifactStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly dir: string,
    private readonly deps: { ids: IdGenerator; clock: Clock; redactor: Redactor },
  ) {}

  storeText(projectId: string, kind: string, text: string): ArtifactRecord {
    const { value } = this.deps.redactor.redactString(text);
    const content = Buffer.from(value, 'utf8');
    const artifact_id = this.deps.ids.next('artifact');
    const rel = `${kind.replace(/[^a-z0-9_-]/gi, '_')}/${artifact_id}.txt`;
    const abs = path.join(this.dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    const record: ArtifactRecord = {
      artifact_id,
      project_id: projectId,
      kind,
      path: rel,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.length,
      created_at: this.deps.clock.now(),
    };
    this.db
      .prepare(
        'INSERT INTO artifacts (artifact_id, project_id, kind, path, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(record.artifact_id, projectId, kind, rel, record.sha256, record.bytes, record.created_at);
    return record;
  }

  get(artifactId: string): ArtifactRecord | undefined {
    return this.db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get<ArtifactRecord>(artifactId);
  }

  readText(artifactId: string): string {
    const rec = this.get(artifactId);
    if (!rec) throw new FridayError('invalid_request', `unknown artifact ${artifactId}`);
    return readFileSync(path.join(this.dir, rec.path), 'utf8');
  }
}

export const artifactRef = (id: string) => `artifact:${id}`;
