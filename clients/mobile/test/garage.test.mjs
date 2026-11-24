import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panels, prepare } from '../../shared/features.ts';
import { loadBikeInsights, missingContext, operationValues, resultFields, shortcuts } from '../../shared/garage.ts';

const motorcycleId = '12345678-1234-4321-9876-123456789abc';
const workshopId = '02345678-1234-4321-9876-123456789abc';

test('quick actions use the active motorcycle and produce valid event requests', () => {
  for (const item of shortcuts.filter(shortcut => shortcut.action === 'event')) {
    const event = panels[0].actions.find(action => action.id === item.action);
    const values = { ...item.values, motorcycleId, amountCop: '95000', occurredAt: '2026-01-12' };
    const request = prepare(event, values);
    assert.equal(missingContext(event, values), '');
    assert.equal(missingContext(event, { ...values, motorcycleId: '' }), 'Selecciona o indica una motocicleta.');
    assert.deepEqual(request.errors, {});
    assert.equal(request.path, '/api/core/motorcycles/' + motorcycleId + '/events');
    assert.deepEqual(request.body, { ...item.values, amountCop: 95000, occurredAt: '2026-01-12T12:00:00.000Z' });
  }
});

test('role assignment only sends workshop scope for a workshop administrator', () => {
  const action = panels.find(panel => panel.id === 'admin').actions.find(item => item.id === 'role');
  const promoted = { userId: motorcycleId, role: 'WORKSHOP_ADMIN', workshopId };
  assert.equal(missingContext(action, { ...promoted, workshopId: '' }), 'Selecciona o indica un taller.');
  assert.deepEqual(prepare(action, operationValues(action, promoted)).body, { role: 'WORKSHOP_ADMIN', workshopId });
  assert.deepEqual(prepare(action, operationValues(action, { ...promoted, role: 'RIDER' })).body, { role: 'RIDER' });
});

test('summary preserves zero costs when predictions are unavailable', async () => {
  const paths = [];
  const insights = await loadBikeInsights(async path => {
    paths.push(path);
    if (path.endsWith('/recommendation')) throw new Error('Falta historial');
    return { tco_cop: 0 };
  }, motorcycleId);
  assert.deepEqual(insights, { tco: { tco_cop: 0 }, recommendation: undefined });
  assert.ok(paths.every(path => path.startsWith('/api/analytics/motorcycles/' + motorcycleId)));
});

test('results format currency, dates and labels without displaying vehicle scope UUIDs', () => {
  const fields = resultFields({ motorcycle_id: motorcycleId, workshopId, amountCop: 95000, occurred_at: '2026-01-12', kind: 'MAINTENANCE' });
  assert.equal(fields.length, 3);
  assert.equal(fields[0].value, '$ 95.000 COP');
  assert.match(fields[1].value, /^12 (?:de )?ene\.? (?:de )?2026$/);
  assert.equal(fields[2].value, 'Mantenimiento');
  assert.equal(fields.at(-1).badge, 'MAINTENANCE');
});
