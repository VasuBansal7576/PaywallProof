import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteControlDocuments } from './control-documents.ts';

const databases: Database.Database[] = [];

function setup() {
  const database = new Database(':memory:');
  databases.push(database);
  return { database, documents: new SqliteControlDocuments(database) };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('SQLite control documents', () => {
  it('owns JSON serialization, replacement, and newest-first listing', () => {
    const { documents } = setup();
    documents.put('run', 'first', { status: 'created' });
    documents.put('run', 'second', { status: 'running' });
    documents.put('run', 'first', { status: 'completed' });

    expect(documents.get('run', 'first')).toEqual({ status: 'completed' });
    expect(documents.get('run', 'missing')).toBeNull();
    expect(documents.list('run')).toEqual([{ status: 'running' }, { status: 'completed' }]);
  });

  it('deletes only run-owned documents of the requested kind', () => {
    const { documents } = setup();
    documents.put('mcp-token', 'token-1', { runId: 'run-1' });
    documents.put('mcp-token', 'token-2', { runId: 'run-2' });
    documents.put('other', 'token-3', { runId: 'run-1' });

    expect(documents.deleteRunOwned('mcp-token', 'run-1')).toBe(1);
    expect(documents.get('mcp-token', 'token-1')).toBeNull();
    expect(documents.get('mcp-token', 'token-2')).toEqual({ runId: 'run-2' });
    expect(documents.get('other', 'token-3')).toEqual({ runId: 'run-1' });
  });
});
