import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteControlDocuments } from './control-documents.ts';
import { CheckoutContinuationStore } from './checkout-continuation.ts';

const databases: Database.Database[] = [];

function setup() {
  const database = new Database(':memory:');
  const documents = new SqliteControlDocuments(database);
  databases.push(database);
  return { database, documents, continuations: new CheckoutContinuationStore(documents) };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('checkout continuation persistence', () => {
  it('stores pending state and resumes the same session with its confirmed turn', () => {
    const { documents, continuations } = setup();
    const observed = continuations.observe('run-1', {
      sessionId: 'session-1',
      previousTurnId: 'turn-1',
    });
    const dispatched = continuations.dispatch('run-1', observed);
    expect(continuations.load('run-1')).toEqual(dispatched);

    const confirmed = continuations.confirm('run-1', dispatched, 'turn-2');

    expect(continuations.load('run-1')).toEqual(confirmed);
    expect(documents.get('runtime', 'run-1')).toEqual({
      sessionId: 'session-1',
      turnId: 'turn-2',
      lastSequenceNumber: 0,
      status: 'running',
    });
  });

  it('cannot persist confirmation without the matching resumed runtime state', () => {
    const { database, documents, continuations } = setup();
    const observed = continuations.observe('run-1', {
      sessionId: 'session-1',
      previousTurnId: 'turn-1',
    });
    const dispatched = continuations.dispatch('run-1', observed);
    database.exec(`
      CREATE TRIGGER reject_runtime_insert
      BEFORE INSERT ON control_documents
      WHEN NEW.kind = 'runtime'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic runtime write failure');
      END;
    `);

    expect(() => continuations.confirm('run-1', dispatched, 'turn-2')).toThrow(
      'synthetic runtime write failure',
    );
    expect(continuations.load('run-1')).toEqual(dispatched);
    expect(documents.get('runtime', 'run-1')).toBeNull();
  });
});
