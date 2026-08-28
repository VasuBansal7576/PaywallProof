import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const userSchema = z.object({
  id: z.string(), run_id: z.string(), fixture_marker: z.string(), customer_id: z.string().nullable(),
  status: z.string(), subscription_id: z.string().nullable(), price_id: z.string().nullable(),
  initial_payment_confirmed: z.number(), cancel_at_period_end: z.number(), period_end: z.number().nullable(),
  billing_mode: z.enum(['none', 'local_replay', 'polar_sandbox']), last_event_created: z.number(),
});
export type User = z.infer<typeof userSchema>;
export type BillingUpdate = {
  customerId: string; subscriptionId: string; priceId: string; status: string;
  initialPaymentConfirmed: boolean; cancelAtPeriodEnd: boolean; periodEnd: number;
};
export type EventMode = 'local_replay' | 'polar_sandbox';

export class TargetError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 503) {
    super(code);
  }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class ReferenceStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reference_users (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, fixture_marker TEXT NOT NULL,
        customer_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'none', subscription_id TEXT,
        price_id TEXT, initial_payment_confirmed INTEGER NOT NULL DEFAULT 0,
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0, period_end INTEGER,
        billing_mode TEXT NOT NULL DEFAULT 'none', last_event_created INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS reference_operations (
        operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, fixture_marker TEXT NOT NULL, principal_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reference_sessions (
        token_hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES reference_users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reference_events (
        event_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, mode TEXT NOT NULL,
        run_id TEXT NOT NULL, principal_id TEXT NOT NULL, created INTEGER NOT NULL, received_at INTEGER NOT NULL
      );
    `);
  }

  close() { this.db.close(); }

  createUser(input: { runId: string; operationId: string; fixtureMarker: string }) {
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM reference_operations WHERE operation_id = ?').get(input.operationId);
      if (previous !== undefined) {
        const operation = z.object({ run_id: z.string(), fixture_marker: z.string(), principal_id: z.string() }).parse(previous);
        if (operation.run_id !== input.runId || operation.fixture_marker !== input.fixtureMarker) throw new TargetError('OPERATION_CONFLICT', 409);
        if (!this.findUser(operation.principal_id)) throw new TargetError('FIXTURE_ALREADY_REMOVED', 410);
        return { principalId: operation.principal_id, runId: operation.run_id, fixtureMarker: operation.fixture_marker };
      }
      const principalId = `usr_${randomUUID()}`;
      this.db.prepare('INSERT INTO reference_users (id, run_id, fixture_marker) VALUES (?, ?, ?)').run(principalId, input.runId, input.fixtureMarker);
      this.db.prepare('INSERT INTO reference_operations (operation_id, run_id, fixture_marker, principal_id) VALUES (?, ?, ?, ?)').run(input.operationId, input.runId, input.fixtureMarker, principalId);
      return { principalId, runId: input.runId, fixtureMarker: input.fixtureMarker };
    })();
  }

  findUser(id: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM reference_users WHERE id = ?').get(id);
    return row === undefined ? undefined : userSchema.parse(row);
  }

  ownedUser(id: string, runId: string): User {
    const user = this.findUser(id);
    if (!user) throw new TargetError('USER_NOT_FOUND', 404);
    if (user.run_id !== runId) throw new TargetError('RUN_OWNERSHIP_MISMATCH', 403);
    return user;
  }

  customerUser(customerId: string): User {
    const row = this.db.prepare('SELECT * FROM reference_users WHERE customer_id = ?').get(customerId);
    if (!row) throw new TargetError('CUSTOMER_NOT_OWNED', 403);
    return userSchema.parse(row);
  }

  linkCustomer(id: string, runId: string, customerId: string) {
    this.db.transaction(() => {
      const user = this.ownedUser(id, runId);
      if (user.customer_id && user.customer_id !== customerId) throw new TargetError('CUSTOMER_ALREADY_LINKED', 409);
      const other = this.db.prepare('SELECT id FROM reference_users WHERE customer_id = ? AND id != ?').get(customerId, id);
      if (other) throw new TargetError('CUSTOMER_ALREADY_OWNED', 409);
      this.db.prepare('UPDATE reference_users SET customer_id = ? WHERE id = ?').run(customerId, id);
    })();
  }

  session(id: string, runId: string) {
    this.ownedUser(id, runId);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 15 * 60 * 1000;
    this.db.prepare('DELETE FROM reference_sessions WHERE expires_at <= ?').run(Date.now());
    this.db.prepare('INSERT INTO reference_sessions (token_hash, principal_id, expires_at) VALUES (?, ?, ?)').run(hash(token), id, expiresAt);
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  sessionUser(token: string | undefined): User | undefined {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const row = this.db.prepare(`SELECT u.* FROM reference_users u JOIN reference_sessions s ON s.principal_id = u.id WHERE s.token_hash = ? AND s.expires_at > ?`).get(hash(token), Date.now());
    return row === undefined ? undefined : userSchema.parse(row);
  }

  removeUser(id: string, runId: string) {
    this.db.transaction(() => {
      const user = this.findUser(id);
      if (!user) {
        const receipt = this.db.prepare('SELECT run_id FROM reference_operations WHERE principal_id = ?').get(id);
        if (!receipt) throw new TargetError('USER_NOT_FOUND', 404);
        if (z.object({ run_id: z.string() }).parse(receipt).run_id !== runId) throw new TargetError('RUN_OWNERSHIP_MISMATCH', 403);
        return;
      }
      this.ownedUser(id, runId);
      this.db.prepare('DELETE FROM reference_users WHERE id = ?').run(id);
    })();
  }

  eventAlreadyProcessed(eventId: string, rawBody: string, mode: EventMode): boolean {
    const previous = this.db.prepare('SELECT payload_hash, mode FROM reference_events WHERE event_id = ?').get(eventId);
    if (!previous) return false;
    const receipt = z.object({ payload_hash: z.string(), mode: z.string() }).parse(previous);
    if (receipt.payload_hash !== hash(rawBody) || receipt.mode !== mode) throw new TargetError('EVENT_ID_CONFLICT', 409);
    return true;
  }

  applyEvent(input: {
    eventId: string; rawBody: string; created: number; mode: EventMode; user: User;
    billing: BillingUpdate; skipProjection: boolean;
  }): 'processed' | 'duplicate' | 'stale' {
    return this.db.transaction(() => {
      const payloadHash = hash(input.rawBody);
      const previous = this.db.prepare('SELECT payload_hash, mode FROM reference_events WHERE event_id = ?').get(input.eventId);
      if (previous) {
        const receipt = z.object({ payload_hash: z.string(), mode: z.string() }).parse(previous);
        if (receipt.payload_hash !== payloadHash || receipt.mode !== input.mode) throw new TargetError('EVENT_ID_CONFLICT', 409);
        return 'duplicate';
      }
      const current = this.ownedUser(input.user.id, input.user.run_id);
      if (current.customer_id !== input.billing.customerId) throw new TargetError('CUSTOMER_MAPPING_CHANGED', 409);
      if (current.billing_mode !== 'none' && current.billing_mode !== input.mode) throw new TargetError('BILLING_MODE_CONFLICT', 409);
      if (current.subscription_id && current.subscription_id !== input.billing.subscriptionId) throw new TargetError('MULTIPLE_SUBSCRIPTIONS_UNSUPPORTED', 422);
      this.db.prepare('INSERT INTO reference_events (event_id, payload_hash, mode, run_id, principal_id, created, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(input.eventId, payloadHash, input.mode, current.run_id, current.id, input.created, Date.now());
      // Replay has no provider read, so its signed event timestamp is the ordering authority.
      if (input.mode === 'local_replay' && input.created < current.last_event_created) return 'stale';
      if (!input.skipProjection) {
        const b = input.billing;
        this.db.prepare(`UPDATE reference_users SET status = ?, subscription_id = ?, price_id = ?, initial_payment_confirmed = ?, cancel_at_period_end = ?, period_end = ?, billing_mode = ?, last_event_created = ? WHERE id = ?`).run(b.status, b.subscriptionId, b.priceId, Number(b.initialPaymentConfirmed), Number(b.cancelAtPeriodEnd), b.periodEnd, input.mode, Math.max(input.created, current.last_event_created), current.id);
      } else {
        this.db.prepare('UPDATE reference_users SET billing_mode = ?, last_event_created = ? WHERE id = ?').run(input.mode, Math.max(input.created, current.last_event_created), current.id);
      }
      return 'processed';
    })();
  }
}
