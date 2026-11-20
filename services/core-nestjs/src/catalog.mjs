import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canAccessMotorcycle } from './domain/access.ts';

const uuid = z.uuid();
const name = z.string().trim().min(1).max(100);
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,40}$/);

export const catalogSchemas = {
  workshop: z.strictObject({ name, documentId: code }),
  product: z.strictObject({ sku: code, name }),
  motorcycle: z.strictObject({ plate: code, make: name, model: name,
    ownerId: uuid.optional(), workshopId: uuid.optional() }),
  motorcycleUpdate: z.strictObject({ plate: code, make: name, model: name, workshopId: uuid.nullable().optional() }),
  odometer: z.strictObject({ kilometers: z.int().min(0).max(2147483647) }),
  invoice: z.strictObject({ motorcycleId: uuid, series: code,
    invoiceNumber: z.int().positive(), amountCop: z.int().min(0) }),
  role: z.strictObject({ role: z.enum(['RIDER', 'WORKSHOP_ADMIN', 'SUPER_ADMIN']), workshopId: uuid.optional() }),
};

export async function enqueue(client, kind, payload) {
  await client.query('INSERT INTO projection_outbox(id, kind, payload) VALUES ($1, $2, $3)',
    [randomUUID(), kind, payload]);
}

export function catalogHandlers({ db, authenticate, validate, failure, auditReader }) {
  function requireSuper(account) {
    if (account.role !== 'SUPER_ADMIN') throw failure(403, 'Acceso restringido.');
  }

  function requireWorkshop(account, workshopId) {
    if (account.role !== 'SUPER_ADMIN' && !(account.role === 'WORKSHOP_ADMIN'
        && account.workshopId === workshopId)) throw failure(403, 'Taller fuera de tu ámbito.');
  }

  async function query(sql, args, client = db) {
    try {
      return await client.query(sql, args);
    } catch (error) {
      if (error.code === '23505') throw failure(409, 'Ya existe un registro con estos datos.');
      if (error.code === '23503') throw failure(404, 'Recurso relacionado no encontrado.');
      throw error;
    }
  }

  async function tx(run) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function scope(account, motorcycleId, client) {
    const { rows: [motorcycle] } = await client.query(
      'SELECT owner_id AS "ownerId", workshop_id AS "workshopId", odometer_km FROM motorcycles WHERE id=$1 FOR UPDATE',
      [motorcycleId],
    );
    if (!motorcycle) throw failure(404, 'Motocicleta no encontrada.');
    if (!canAccessMotorcycle(account, motorcycle)) throw failure(403, 'Motocicleta fuera de tu ámbito.');
    return motorcycle;
  }

  return {
    async listWorkshops(req) {
      const { account } = await authenticate(req);
      if (account.role === 'RIDER') throw failure(403, 'Acceso restringido.');
      return (await query('SELECT id, name, document_id FROM workshops WHERE ($1::uuid IS NULL OR id=$1) ORDER BY id LIMIT 100',
        [account.workshopId ?? null])).rows;
    },

    async createWorkshop(body, req) {
      requireSuper((await authenticate(req)).account);
      const input = validate(catalogSchemas.workshop, body);
      return (await query('INSERT INTO workshops(name, document_id) VALUES ($1,$2) RETURNING *',
        [input.name, input.documentId])).rows[0];
    },

    async listProducts(req) {
      const { account } = await authenticate(req);
      const workshopId = validate(uuid, req.params.workshopId).toLowerCase();
      requireWorkshop(account, workshopId);
      return (await query('SELECT sku, name FROM workshop_products WHERE workshop_id=$1 ORDER BY sku LIMIT 100',
        [workshopId])).rows;
    },

    async createProduct(body, req) {
      const { account } = await authenticate(req);
      const workshopId = validate(uuid, req.params.workshopId).toLowerCase();
      requireWorkshop(account, workshopId);
      const input = validate(catalogSchemas.product, body);
      return (await query('INSERT INTO workshop_products(workshop_id,sku,name) VALUES ($1,$2,$3) RETURNING *',
        [workshopId, input.sku, input.name])).rows[0];
    },

    async listMotorcycles(req) {
      const { account } = await authenticate(req);
      return (await query(`SELECT * FROM motorcycles
        WHERE $1='SUPER_ADMIN' OR ($1='WORKSHOP_ADMIN' AND workshop_id=$2) OR ($1='RIDER' AND owner_id=$3)
        ORDER BY id LIMIT 100`, [account.role, account.workshopId ?? null, account.id])).rows;
    },

    async createMotorcycle(body, req) {
      const { account } = await authenticate(req);
      const input = validate(catalogSchemas.motorcycle, body);
      let owner = input.ownerId ?? account.id;
      let workshop = input.workshopId?.toLowerCase() ?? null;
      if (account.role === 'RIDER' && (owner.toLowerCase() !== account.id || workshop)) {
        throw failure(403, 'Solo puedes crear motocicletas propias sin asignación de taller.');
      }
      if (account.role === 'WORKSHOP_ADMIN') {
        // Un taller puede operar sobre vehículos asignados; la asignación la controla el administrador global.
        throw failure(403, 'El alta para terceros requiere administración global.');
      }
      return (await query('INSERT INTO motorcycles(owner_id, workshop_id, plate, make, model) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [owner, workshop, input.plate, input.make, input.model])).rows[0];
    },

    async updateMotorcycle(body, req) {
      const { account } = await authenticate(req);
      const motorcycleId = validate(uuid, req.params.motorcycleId).toLowerCase();
      const input = validate(catalogSchemas.motorcycleUpdate, body);
      if (input.workshopId !== undefined && account.role !== 'SUPER_ADMIN') {
        throw failure(403, 'Solo el administrador global puede cambiar el taller.');
      }
      return tx(async client => {
        const current = await scope(account, motorcycleId, client);
        const workshop = input.workshopId === undefined ? current.workshopId : input.workshopId;
        return (await query(`UPDATE motorcycles SET plate=$1, make=$2, model=$3, workshop_id=$4
          WHERE id=$5 RETURNING *`, [input.plate, input.make, input.model, workshop, motorcycleId], client)).rows[0];
      });
    },

    async deleteMotorcycle(req) {
      const { account } = await authenticate(req);
      const motorcycleId = validate(uuid, req.params.motorcycleId).toLowerCase();
      if (account.role === 'WORKSHOP_ADMIN') throw failure(403, 'Un taller no puede eliminar motocicletas.');
      return tx(async client => {
        const current = await scope(account, motorcycleId, client);
        if (current.odometer_km > 0) throw failure(409, 'La motocicleta conserva historial de odómetro.');
        try {
          await client.query('DELETE FROM motorcycles WHERE id=$1', [motorcycleId]);
        } catch (error) {
          if (error.code === '23503') throw failure(409, 'La motocicleta conserva eventos o facturas.');
          throw error;
        }
        await enqueue(client, 'audit', { actorId: account.id, action: 'MOTORCYCLE_DELETE',
          subjectId: motorcycleId, outcome: 'DELETED', recordedAt: new Date().toISOString() });
        return { deleted: true };
      });
    },

    async updateOdometer(body, req) {
      const { account } = await authenticate(req);
      const motorcycleId = validate(uuid, req.params.motorcycleId).toLowerCase();
      const { kilometers } = validate(catalogSchemas.odometer, body);
      return tx(async client => {
        const current = await scope(account, motorcycleId, client);
        if (kilometers < current.odometer_km) throw failure(409, 'El odómetro no puede retroceder.');
        if (kilometers === current.odometer_km) return { motorcycleId, kilometers };
        await client.query('UPDATE motorcycles SET odometer_km=$1 WHERE id=$2', [kilometers, motorcycleId]);
        await enqueue(client, 'odometer', { motorcycleId, actorId: account.id, kilometers,
          readingId: randomUUID(), recordedAt: new Date().toISOString() });
        return { motorcycleId, kilometers };
      });
    },

    async listInvoices(req) {
      const { account } = await authenticate(req);
      const workshopId = validate(uuid, req.params.workshopId).toLowerCase();
      requireWorkshop(account, workshopId);
      return (await query('SELECT * FROM service_invoices WHERE workshop_id=$1 ORDER BY issued_at DESC LIMIT 100',
        [workshopId])).rows;
    },

    async createInvoice(body, req) {
      const { account } = await authenticate(req);
      const workshopId = validate(uuid, req.params.workshopId).toLowerCase();
      requireWorkshop(account, workshopId);
      const input = validate(catalogSchemas.invoice, body);
      return tx(async client => {
        const motorcycle = await scope(account, input.motorcycleId, client);
        if (motorcycle.workshopId !== workshopId) throw failure(403, 'La motocicleta pertenece a otro ámbito.');
        return (await query(`INSERT INTO service_invoices(workshop_id,motorcycle_id,series,invoice_number,amount_cop)
          VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [workshopId, input.motorcycleId, input.series, input.invoiceNumber, input.amountCop], client)).rows[0];
      });
    },

    async changeRole(body, req) {
      const { account } = await authenticate(req);
      requireSuper(account);
      const userId = validate(uuid, req.params.userId).toLowerCase();
      const input = validate(catalogSchemas.role, body);
      if (userId === account.id) throw failure(409, 'Un administrador no puede cambiar su propio rol.');
      if (Boolean(input.workshopId) !== (input.role === 'WORKSHOP_ADMIN')) throw failure(400, 'Ámbito inválido.');
      return tx(async client => {
        const { rows: [row] } = await query(`UPDATE users SET role=$1, workshop_id=$2, session_version=session_version+1
          WHERE id=$3 RETURNING id, role, workshop_id`, [input.role, input.workshopId ?? null, userId], client);
        if (!row) throw failure(404, 'Cuenta no encontrada.');
        await enqueue(client, 'audit', { actorId: account.id, action: 'ROLE_CHANGE', subjectId: userId,
          outcome: input.role, recordedAt: new Date().toISOString() });
        return row;
      });
    },

    async audit(req) {
      const { account } = await authenticate(req);
      requireSuper(account);
      const day = validate(z.iso.date(), req.query.day ?? new Date().toISOString().slice(0,10));
      return auditReader(day);
    },
  };
}
