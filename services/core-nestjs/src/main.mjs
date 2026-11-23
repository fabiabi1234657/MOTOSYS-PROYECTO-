import 'reflect-metadata';
import {
  Controller, Get, Post, Patch, Delete, Body, Req, Res, Module, HttpException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import { createClient } from 'redis';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { decryptTotpSecret } from './totp-secret.mjs';
import { oidcHandlers } from './oidc.mjs';
import { startNotifications } from './notifications.mjs';
import { startProjections } from './projections.mjs';
import { catalogHandlers, enqueue } from './catalog.mjs';
import { passwordResetHandlers } from './password-reset.mjs';
import { TcoPool, tcoInput } from './tco-pool.mjs';
import { openapi } from './openapi.mjs';
import { PasswordPolicy } from './domain/password-policy.ts';
import { canAccessMotorcycle } from './domain/access.ts';
import { RegisterVehicleEvent } from './application/use-cases/register-vehicle-event.ts';
import { PostgresVehicleEventStore } from './infrastructure/adapters/out/postgres-vehicle-event-store.ts';

const { DATABASE_URL, REDIS_URL } = process.env;
if (!DATABASE_URL || !REDIS_URL) throw new Error('DATABASE_URL y REDIS_URL son obligatorios.');
const db = new pg.Pool({ connectionString: DATABASE_URL, max: 8, connectionTimeoutMillis: 3000 });
const redis = createClient({ url: REDIS_URL, disableOfflineQueue: true });
redis.on('error', () => process.stderr.write('Redis no disponible.\n'));
await redis.connect();
const stopNotifications = startNotifications(db);
const projections = startProjections(db);
const tco = new TcoPool();
const registerEvent = new RegisterVehicleEvent(new PostgresVehicleEventStore(db));
const denylist = new Set(['password123456789', '123456789012345', 'qwertyuiopasdfgh',
  ...(process.env.PASSWORD_DENYLIST ?? '').split(',').filter(Boolean).map(value => value.normalize('NFC').toLowerCase())]);
const policy = new PasswordPolicy(denylist);
const hashOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const dummyHash = await argon2.hash(randomBytes(24).toString('hex'), hashOptions);
const sha = value => createHash('sha256').update(value).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');
const cacheMetrics = { hits: 0, misses: 0, errors: 0, latencyMs: 0 };
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const credentials = { email, password: z.string().min(1).max(512) };
const id = z.uuid();
const asAccount = row => ({ id: row.id, role: row.role, workshopId: row.workshop_id });
const failure = (status, message) => new HttpException({ statusCode: status, message }, status);

function validate(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw failure(400, 'Datos de solicitud inválidos.');
  return result.data;
}

function cookie(req, name) {
  return req.headers.cookie?.split(';').map(entry => entry.trim())
    .find(entry => entry.startsWith(name + '='))?.slice(name.length + 1);
}

function matched(a, b) {
  return typeof a === 'string' && typeof b === 'string' && /^[\w-]{43}$/.test(a)
    && /^[\w-]{43}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function authenticate(req) {
  const header = req.headers.authorization;
  const token = header ? /^Bearer ([\w-]{43})$/.exec(header)?.[1] : cookie(req, '__Host-motosys');
  if (!token || !/^[\w-]{43}$/.test(token)) throw failure(401, 'Sesión requerida.');
  if (!header && !['GET', 'HEAD'].includes(req.method)
      && !matched(req.headers['x-csrf-token'], cookie(req, '__Host-motosys-csrf'))) {
    throw failure(403, 'Validación CSRF fallida.');
  }
  const key = 'session:' + sha(token);
  const data = await redis.get(key);
  if (!data) throw failure(401, 'Sesión caducada.');
  const session = JSON.parse(data);
  const remaining = session.expiresAt - Date.now();
  if (remaining <= 0 || !await redis.pExpire(key, Math.min(remaining, 1800000))) {
    throw failure(401, 'Sesión caducada.');
  }
  const { rows: [row] } = await db.query('SELECT id, role, workshop_id, session_version FROM users WHERE id=$1', [session.userId]);
  if (!row || (session.version ?? 0) !== row.session_version || (row.role !== 'RIDER' && !session.mfa)) throw failure(401, 'Sesión caducada.');
  if (row.role !== 'RIDER') {
    await enqueue(db, 'audit', { actorId: row.id, action: 'ADMIN_ACCESS',
      subjectId: req.route?.path ?? '/', outcome: 'AUTHENTICATED', recordedAt: new Date().toISOString() });
  }
  return { account: asAccount(row), key };
}

async function createSession(row, client, res, mfa) {
  if (row.role !== 'RIDER') {
    await enqueue(db, 'audit', { actorId: row.id, action: 'ADMIN_LOGIN', subjectId: row.id,
      outcome: 'AUTHENTICATED', recordedAt: new Date().toISOString() });
  }
  const token = randomToken();
  await redis.set('session:' + sha(token), JSON.stringify({
    userId: row.id, expiresAt: Date.now() + 28800000, mfa, version: row.session_version,
  }), { PX: 1800000 });
  if (client === 'web') {
    const csrf = randomToken();
    const opts = { secure: true, sameSite: 'lax', path: '/', maxAge: 28800000 };
    res.cookie('__Host-motosys', token, { ...opts, httpOnly: true });
    res.cookie('__Host-motosys-csrf', csrf, opts);
    return { account: asAccount(row), csrfToken: csrf };
  }
  return { account: asAccount(row), accessToken: token };
}

async function throttle(namespace, subject, maximum) {
  const key = 'limit:' + namespace + ':' + sha(subject);
  const count = await redis.eval(
    "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],300) end; return n",
    { keys: [key], arguments: [] },
  );
  if (count > maximum) throw failure(429, 'Demasiados intentos. Intenta más tarde.');
}

async function verifyMfa(row, code) {
  if (!row.totp_secret || !/^\d{6}$/.test(code ?? '') || !authenticator.check(code, decryptTotpSecret(row.totp_secret, row.id))) {
    throw failure(401, 'Segundo factor requerido o inválido.');
  }
  const fresh = await redis.set('totp:' + row.id + ':' + sha(code), '1', { NX: true, EX: 60 });
  if (!fresh) throw failure(401, 'Segundo factor requerido o inválido.');
}

async function accessibleMotorcycle(actor, motorcycleId) {
  const { rows: [row] } = await db.query(
    'SELECT owner_id AS "ownerId", workshop_id AS "workshopId" FROM motorcycles WHERE id=$1', [motorcycleId],
  );
  if (!row) throw failure(404, 'Motocicleta no encontrada.');
  if (!canAccessMotorcycle(actor, row)) throw failure(403, 'Motocicleta fuera de tu ámbito.');
}

function cacheKeys(motorcycleId) {
  const versionKey = 'cache:vehicle-events:version:' + motorcycleId;
  return { versionKey, snapshotKey: 'cache:vehicle-events:list:' + motorcycleId };
}

async function listEvents(motorcycleId) {
  const start = performance.now();
  const { versionKey, snapshotKey } = cacheKeys(motorcycleId);
  let version;
  try {
    const snapshot = await redis.mGet([versionKey, snapshotKey]);
    version = snapshot[0];
    const hit = snapshot[1];
    if (hit) {
      const entry = JSON.parse(hit);
      if (entry.version === version) {
        cacheMetrics.hits++;
        return entry.events;
      }
    }
    cacheMetrics.misses++;
  } catch {
    cacheMetrics.errors++;
  } finally {
    cacheMetrics.latencyMs += performance.now() - start;
  }
  const { rows: events } = await db.query(
    `SELECT id, kind, category, description, amount_cop, occurred_at
     FROM vehicle_events WHERE motorcycle_id=$1 ORDER BY occurred_at DESC, id DESC LIMIT 100`,
    [motorcycleId],
  );
  if (version !== undefined) {
    try {
      await redis.eval(
        "local v=redis.call('GET',KEYS[1]) or ''; if v==ARGV[1] then return redis.call('SET',KEYS[2],ARGV[2],'EX',60) end",
        { keys: [versionKey, snapshotKey], arguments: [version ?? '', JSON.stringify({ version, events })] },
      );
    } catch {
      cacheMetrics.errors++;
    }
  }
  return events;
}

const federated = oidcHandlers({ redis, db, failure, cookie, matched, createSession, verifyMfa, randomToken, sha });

const catalog = catalogHandlers({ db, authenticate, validate, failure, auditReader: projections.auditReader });
const recovery = passwordResetHandlers({ db, redis, policy, randomToken, sha, validate, failure, throttle,
  hashPassword: password => argon2.hash(password, hashOptions) });

class CoreController {
  specification() { return openapi; }

  async forecast(body, req) {
    const { account } = await authenticate(req);
    await throttle('tco', account.id, 20);
    const { cases } = validate(tcoInput, body);
    try {
      return await tco.calculate(cases);
    } catch {
      throw failure(503, 'El cálculo de TCO no está disponible.');
    }
  }
  async session(req) {
    const { account } = await authenticate(req);
    return { account };
  }

  oidcStart(req, res) {
    const challenge = req.query.challenge === undefined ? undefined
      : validate(z.string().regex(/^[a-f0-9]{64}$/), req.query.challenge);
    return federated.start(req.params.provider, res, req.query.ui === '1', challenge);
  }

  async oidcMobile(body, req, res) {
    await throttle('oidc-mobile', req.ip, 30);
    const { ticket, verifier, code } = validate(z.strictObject({
      ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      verifier: z.string().regex(/^[a-f0-9]{64}$/),
      code: z.string().regex(/^\d{6}$/).optional(),
    }), body);
    return federated.exchangeMobile(ticket, verifier, code, res);
  }

  oidcCallback(req, res) { return federated.callback(req.params.provider, req, res); }

  oidcMfa(body, req, res) {
    const { code } = validate(z.strictObject({ code: z.string().regex(/^\d{6}$/) }), body);
    return federated.complete(req, res, code);
  }
  health() { return { status: 'ok' }; }

  async register(body, req) {
    await throttle('registration', req.ip, 10);
    const input = validate(z.strictObject(credentials), body);
    let password;
    try {
      password = policy.validate(input.password, false);
    } catch (error) {
      throw failure(400, error.message);
    }
    const passwordHash = await argon2.hash(password, hashOptions);
    const { rows: [row] } = await db.query(
      `INSERT INTO users(email, password_hash) VALUES ($1,$2)
       ON CONFLICT (email) DO NOTHING RETURNING id, role`,
      [input.email, passwordHash],
    );
    if (!row) throw failure(409, 'Ya existe una cuenta con ese correo.');
    return asAccount(row);
  }

  async login(body, req, res) {
    const input = validate(z.strictObject({
      ...credentials, client: z.enum(['web','mobile']), totp: z.string().length(6).optional(),
    }), body);
    await throttle('login-ip', req.ip, 30);
    await throttle('login-account', input.email, 8);
    const { rows: [row] } = await db.query(
      'SELECT id, role, workshop_id, password_hash, totp_secret, session_version FROM users WHERE email=$1', [input.email],
    );
    const passwordOk = await argon2.verify(row?.password_hash ?? dummyHash, input.password.normalize('NFC'));
    if (!row?.password_hash || !passwordOk) throw failure(401, 'Credenciales inválidas.');
    const mfa = Boolean(row.totp_secret) || row.role !== 'RIDER';
    if (mfa) await verifyMfa(row, input.totp);
    return createSession(row, input.client, res, mfa);
  }

  async logout(req, res) {
    const { key } = await authenticate(req);
    await redis.del(key);
    for (const name of ['__Host-motosys', '__Host-motosys-csrf']) {
      res.clearCookie(name, { secure: true, sameSite: 'lax', path: '/' });
    }
    return { closed: true };
  }

  async events(req) {
    const { account } = await authenticate(req);
    const motorcycleId = validate(id, req.params.motorcycleId).toLowerCase();
    await accessibleMotorcycle(account, motorcycleId);
    return listEvents(motorcycleId);
  }

  async addEvent(body, req, res) {
    const { account } = await authenticate(req);
    const event = validate(z.strictObject({
      kind: z.enum(['MAINTENANCE','EXPENSE']), category: z.string().trim().min(1).max(80),
      description: z.string().trim().min(1).max(500), amountCop: z.int().min(0),
      occurredAt: z.iso.datetime({ offset: true }),
    }), body);
    const motorcycleId = validate(id, req.params.motorcycleId).toLowerCase();
    const idempotencyKey = validate(z.string().regex(/^[\w-]{1,128}$/), req.headers['idempotency-key']);
    const result = await registerEvent.execute(account, { ...event, motorcycleId, idempotencyKey });
    if (result.status === 'conflict') throw failure(409, 'La clave ya se usó con otros datos.');
    if (result.status === 'missing') throw failure(404, 'Motocicleta no encontrada.');
    if (result.status === 'forbidden') throw failure(403, 'Motocicleta fuera de tu ámbito.');
    const { versionKey, snapshotKey } = cacheKeys(motorcycleId);
    try {
      await redis.multi().set(versionKey, randomToken(), { EX: 120 }).del(snapshotKey).exec();
    } catch {
      cacheMetrics.errors++;
    }
    res.status(result.status === 'created' ? 201 : 200);
    return result;
  }

  async metrics(req) {
    const { account } = await authenticate(req);
    if (account.role !== 'SUPER_ADMIN') throw failure(403, 'Acceso restringido.');
    return cacheMetrics;
  }
}

Object.assign(CoreController.prototype, catalog, {
  requestPasswordReset: recovery.request,
  confirmPasswordReset: recovery.confirm,
});

const routes = [
  [Get('openapi.json'), 'specification', []],
  [Post('auth/password-reset/request'), 'requestPasswordReset', [Body(), Req(), Res({ passthrough: true })]],
  [Post('auth/password-reset/confirm'), 'confirmPasswordReset', [Body(), Req()]],
  [Get('workshops'), 'listWorkshops', [Req()]],
  [Post('workshops'), 'createWorkshop', [Body(), Req()]],
  [Get('workshops/:workshopId/products'), 'listProducts', [Req()]],
  [Post('workshops/:workshopId/products'), 'createProduct', [Body(), Req()]],
  [Get('motorcycles'), 'listMotorcycles', [Req()]],
  [Post('motorcycles'), 'createMotorcycle', [Body(), Req()]],
  [Patch('motorcycles/:motorcycleId'), 'updateMotorcycle', [Body(), Req()]],
  [Delete('motorcycles/:motorcycleId'), 'deleteMotorcycle', [Req()]],
  [Patch('motorcycles/:motorcycleId/odometer'), 'updateOdometer', [Body(), Req()]],
  [Get('workshops/:workshopId/invoices'), 'listInvoices', [Req()]],
  [Post('workshops/:workshopId/invoices'), 'createInvoice', [Body(), Req()]],
  [Patch('admin/users/:userId/role'), 'changeRole', [Body(), Req()]],
  [Get('admin/audit'), 'audit', [Req()]],
  [Post('analytics/tco'), 'forecast', [Body(), Req()]],
  [Get('health'), 'health', []],
  [Get('auth/oidc/:provider/start'), 'oidcStart', [Req(), Res()]],
  [Get('auth/oidc/:provider/callback'), 'oidcCallback', [Req(), Res({ passthrough: true })]],
  [Post('auth/oidc/mobile/exchange'), 'oidcMobile', [Body(), Req(), Res({ passthrough: true })]],
  [Post('auth/oidc/mfa'), 'oidcMfa', [Body(), Req(), Res({ passthrough: true })]],
  [Post('auth/register'), 'register', [Body(), Req()]],
  [Post('auth/login'), 'login', [Body(), Req(), Res({ passthrough: true })]],
  [Get('auth/session'), 'session', [Req()]],
  [Post('auth/logout'), 'logout', [Req(), Res({ passthrough: true })]],
  [Get('motorcycles/:motorcycleId/events'), 'events', [Req()]],
  [Post('motorcycles/:motorcycleId/events'), 'addEvent', [Body(), Req(), Res({ passthrough: true })]],
  [Get('admin/cache-metrics'), 'metrics', [Req()]],
];
Controller()(CoreController);
for (const [route, name, parameters] of routes) {
  parameters.forEach((decorator, index) => decorator(CoreController.prototype, name, index));
  route(CoreController.prototype, name, Object.getOwnPropertyDescriptor(CoreController.prototype, name));
}
class CoreModule {}
Module({ controllers: [CoreController] })(CoreModule);
const app = await NestFactory.create(CoreModule);
await app.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.close();
    await Promise.all([stopNotifications(), projections.stop(), tco.close()]);
    await Promise.allSettled([db.end(), redis.quit()]);
  });
}
