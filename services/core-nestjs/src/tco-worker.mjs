import { parentPort } from 'node:worker_threads';

parentPort.on('message', cases => {
  const result = cases.map(item => {
    let running = item.purchaseCop;
    const years = [];
    for (let year = 1; year <= item.years; year++) {
      const annual = (item.annualMaintenanceCop + item.annualFuelCop + item.annualInsuranceCop)
        * (1 + item.inflationPct / 100) ** (year - 1);
      running += annual;
      years.push({ year, operatingCop: Math.round(annual), cumulativeCop: Math.round(running) });
    }
    return { years, totalCop: Math.round(running - item.resaleCop) };
  });
  parentPort.postMessage(result);
});
