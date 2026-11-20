import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { TcoPool } from '../src/tco-pool.mjs';

test('TCO devuelve valores correctos y permite atender el event loop durante el cálculo', async () => {
  const pool = new TcoPool();
  try {
    const scenario = { purchaseCop: 100000, annualMaintenanceCop: 1000, annualFuelCop: 2000,
      annualInsuranceCop: 3000, resaleCop: 20000, years: 2, inflationPct: 10 };
    const calculation = pool.calculate(Array.from({ length: 500 }, () => scenario));
    const first = await Promise.race([calculation.then(() => 'result'), setImmediate('loop')]);
    assert.equal(first, 'loop');
    const result = await calculation;
    assert.equal(result.length, 500);
    assert.deepEqual(result[0], {
      totalCop: 92600,
      years: [{ year: 1, operatingCop: 6000, cumulativeCop: 106000 },
        { year: 2, operatingCop: 6600, cumulativeCop: 112600 }],
    });
  } finally {
    await pool.close();
  }
});
