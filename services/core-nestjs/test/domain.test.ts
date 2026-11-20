import assert from 'node:assert/strict';
import test from 'node:test';
import { canAccessMotorcycle } from '../src/domain/access.ts';
import { InvalidPassword, PasswordPolicy } from '../src/domain/password-policy.ts';

const policy = new PasswordPolicy(new Set(['password123456789']));
const motorcycle = { ownerId: 'rider-1', workshopId: 'workshop-1' };

test('la longitud mínima depende de MFA verificado', () => {
  assert.throws(() => policy.validate('12345678901234', false), InvalidPassword);
  assert.equal(policy.validate('123456789012345', false), '123456789012345');
  assert.throws(() => policy.validate('1234567', true), InvalidPassword);
  assert.equal(policy.validate('12345678', true), '12345678');
});

test('acepta frases y cuenta puntos de código después de normalizar', () => {
  const passphrase = 'Una frase larga con espacios y palabras que se pueden recordar.';
  assert.equal(policy.validate(passphrase, false), passphrase);
  assert.equal(policy.validate('e\u0301'.repeat(128), false), 'é'.repeat(128));
  assert.throws(() => policy.validate('🛵'.repeat(129), false), InvalidPassword);
});

test('rechaza contraseñas de la lista sin distinguir mayúsculas', () => {
  assert.throws(() => policy.validate('Password123456789', false), InvalidPassword);
});

test('limita los motociclistas a sus propios vehículos', () => {
  assert.equal(canAccessMotorcycle({ id: 'rider-1', role: 'RIDER' }, motorcycle), true);
  assert.equal(canAccessMotorcycle({ id: 'rider-2', role: 'RIDER' }, motorcycle), false);
});

test('limita administradores de taller al ámbito asignado', () => {
  const account = { id: 'admin-1', role: 'WORKSHOP_ADMIN', workshopId: 'workshop-1' } as const;
  assert.equal(canAccessMotorcycle(account, motorcycle), true);
  assert.equal(canAccessMotorcycle(account, { ...motorcycle, workshopId: 'other' }), false);
  assert.equal(canAccessMotorcycle(account, { ...motorcycle, workshopId: null }), false);
});

test('permite el acceso global del superadministrador', () => {
  assert.equal(canAccessMotorcycle({ id: 'admin-1', role: 'SUPER_ADMIN' }, motorcycle), true);
});

test('el caso de uso aplica el ámbito dentro de la operación del repositorio', async () => {
  const { RegisterVehicleEvent } = await import('../src/application/use-cases/register-vehicle-event.ts');
  const action = new RegisterVehicleEvent({
    async register(actorId, event, authorize) {
      assert.equal(event.idempotencyKey, 'offline-key');
      assert.equal(actorId, 'rider-1');
      return authorize(motorcycle) ? { status: 'created', eventId: 'record-1' } : { status: 'forbidden' };
    },
  });
  const result = await action.execute({ id: 'rider-1', role: 'RIDER' }, {
    motorcycleId: 'moto-1', kind: 'MAINTENANCE', category: 'Aceite',
    description: 'Cambio de aceite', amountCop: 25000,
    occurredAt: '2026-11-20T15:00:00Z', idempotencyKey: 'offline-key',
  });
  assert.deepEqual(result, { status: 'created', eventId: 'record-1' });
});