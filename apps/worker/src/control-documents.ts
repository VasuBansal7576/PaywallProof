import Database from 'better-sqlite3';
import { z } from 'zod';
import { parseJson } from '#domain';

export type ControlDocuments = {
  put(kind: string, id: string, value: unknown): void;
  get(kind: string, id: string): unknown;
  list(kind: string): unknown[];
};

type ControlDocument = {
  kind: string;
  id: string;
  value: unknown;
};

const valueRowSchema = z.object({ value: z.string() });

/** Owns serialization and atomic writes for controller-owned JSON documents. */
export class SqliteControlDocuments implements ControlDocuments {
  constructor(private readonly database: Database.Database) {
    this.database.exec(
      'CREATE TABLE IF NOT EXISTS control_documents(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id))',
    );
  }

  put(kind: string, id: string, value: unknown) {
    this.write({ kind, id, value: JSON.stringify(parseJson(value)) });
  }

  putAll(documents: readonly ControlDocument[]) {
    const encoded = documents.map(({ kind, id, value }) => ({
      kind,
      id,
      value: JSON.stringify(parseJson(value)),
    }));
    this.database.transaction(() => {
      for (const document of encoded) this.write(document);
    })();
  }

  get(kind: string, id: string): unknown {
    const row = this.database
      .prepare('SELECT value FROM control_documents WHERE kind=? AND id=?')
      .get(kind, id);
    return row ? JSON.parse(valueRowSchema.parse(row).value) : null;
  }

  list(kind: string): unknown[] {
    return this.database
      .prepare('SELECT value FROM control_documents WHERE kind=? ORDER BY rowid DESC')
      .all(kind)
      .map((row) => JSON.parse(valueRowSchema.parse(row).value));
  }

  deleteRunOwned(kind: string, runId: string) {
    return this.database
      .prepare("DELETE FROM control_documents WHERE kind=? AND json_extract(value,'$.runId')=?")
      .run(kind, runId).changes;
  }

  private write(document: { kind: string; id: string; value: string }) {
    this.database
      .prepare(
        'INSERT INTO control_documents VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value',
      )
      .run(document.kind, document.id, document.value);
  }
}
