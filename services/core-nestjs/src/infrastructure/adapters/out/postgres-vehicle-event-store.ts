import { createHash } from 'node:crypto';
import type {
  RegistrationResult,
  VehicleEventInput,
} from '../../../application/ports/in/register-vehicle-event.ts';
import type { VehicleEventStore } from '../../../application/ports/out/vehicle-event-store.ts';
import type { MotorcycleScope } from '../../../domain/access.ts';

interface TransactionClient {
  query<Row>(sql: string, parameters?: unknown[]): Promise<{ rows: Row[] }>;
  release(error?: boolean): void;
}

interface Pool {
  connect(): Promise<TransactionClient>;
}

export class PostgresVehicleEventStore implements VehicleEventStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async register(
    actorId: string,
    event: VehicleEventInput,
    authorize: (motorcycle: MotorcycleScope) => boolean,
  ): Promise<RegistrationResult> {
    const client = await this.pool.connect();
    let discardConnection = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await this.registerInTransaction(client, actorId, event, authorize);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discardConnection = true;
      }
      throw error;
    } finally {
      client.release(discardConnection);
    }
  }

  private async registerInTransaction(
    client: TransactionClient,
    actorId: string,
    event: VehicleEventInput,
    authorize: (motorcycle: MotorcycleScope) => boolean,
  ): Promise<RegistrationResult> {
    const { rows: [motorcycle] } = await client.query<MotorcycleScope>(
      `SELECT owner_id AS "ownerId", workshop_id AS "workshopId"
       FROM motorcycles WHERE id = $1 FOR SHARE`,
      [event.motorcycleId],
    );
    if (!motorcycle) return { status: 'missing' };
    if (!authorize(motorcycle)) return { status: 'forbidden' };

    const occurredAt = new Date(event.occurredAt).toISOString();
    const fingerprint = createHash('sha256').update(JSON.stringify([
      event.motorcycleId.toLowerCase(), event.kind, event.category,
      event.description, event.amountCop, occurredAt,
    ])).digest('hex');
    const { rows: [inserted] } = await client.query<{ id: string }>(
      `INSERT INTO vehicle_events
         (actor_id, kind, idempotency_key, motorcycle_id, category, description,
          amount_cop, occurred_at, request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (actor_id, kind, idempotency_key) DO NOTHING
       RETURNING id`,
      [actorId, event.kind, event.idempotencyKey, event.motorcycleId, event.category,
        event.description, event.amountCop, occurredAt, fingerprint],
    );
    if (inserted) {
      await client.query('INSERT INTO notification_outbox(event_id) VALUES ($1)', [inserted.id]);
      await client.query(`INSERT INTO projection_outbox(id,kind,payload)
        SELECT gen_random_uuid(),'analytics',jsonb_build_object(
          'event_id',e.id,'motorcycle_id',m.id,'owner_id',m.owner_id,'workshop_id',m.workshop_id,
          'make',m.make,'kind',e.kind,'category',e.category,'amount_cop',e.amount_cop,'occurred_at',e.occurred_at)
        FROM vehicle_events e JOIN motorcycles m ON m.id=e.motorcycle_id WHERE e.id=$1`, [inserted.id]);
      return { status: 'created', eventId: inserted.id };
    }

    // A separate READ COMMITTED statement sees the winner of a concurrent insert.
    const { rows: [previous] } = await client.query<{ id: string; request_hash: string }>(
      `SELECT id, request_hash FROM vehicle_events
       WHERE actor_id = $1 AND kind = $2 AND idempotency_key = $3`,
      [actorId, event.kind, event.idempotencyKey],
    );
    if (previous?.request_hash === fingerprint) {
      return { status: 'replayed', eventId: previous.id };
    }
    return { status: 'conflict' };
  }
}
