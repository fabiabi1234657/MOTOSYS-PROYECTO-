import { Worker } from 'node:worker_threads';
import { z } from 'zod';

const amount = z.int().min(0).max(1000000000000);
export const tcoInput = z.strictObject({ cases: z.array(z.strictObject({
  purchaseCop: amount, annualMaintenanceCop: amount, annualFuelCop: amount,
  annualInsuranceCop: amount, resaleCop: amount, years: z.int().min(1).max(30),
  inflationPct: z.number().min(0).max(25),
})).min(1).max(500) });

export class TcoPool {
  slots = new Set();
  queue = [];
  closed = false;

  constructor(size = 2, workerUrl = new URL('./tco-worker.mjs', import.meta.url)) {
    this.size = size;
    this.workerUrl = workerUrl;
  }

  calculate(cases) {
    if (this.closed || this.queue.length >= 16) return Promise.reject(new Error('TCO no disponible.'));
    return new Promise((resolve, reject) => {
      const task = { cases, resolve, reject };
      task.expiry = setTimeout(() => {
        const index = this.queue.indexOf(task);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error('Tiempo de espera de TCO agotado.'));
      }, 3000);
      this.queue.push(task);
      this.drain();
    });
  }

  drain() {
    const available = [...this.slots].filter(slot => !slot.task);
    while (this.queue.length && !this.closed) {
      const slot = available.pop() ?? (this.slots.size < this.size ? this.spawn() : null);
      if (!slot) break;
      slot.task = this.queue.shift();
      clearTimeout(slot.task.expiry);
      slot.deadline = setTimeout(() => this.drop(slot, new Error('Tiempo de cálculo de TCO agotado.')), 3000);
      slot.worker.postMessage(slot.task.cases);
    }
  }

  spawn() {
    const worker = new Worker(this.workerUrl, { resourceLimits: { maxOldGenerationSizeMb: 24 } });
    const slot = { worker };
    this.slots.add(slot);
    worker.on('message', result => {
      clearTimeout(slot.deadline);
      slot.task?.resolve(result);
      slot.task = undefined;
      this.drain();
    });
    worker.on('error', error => this.drop(slot, error));
    worker.on('exit', () => this.drop(slot, new Error('Worker TCO cerrado.')));
    return slot;
  }

  drop(slot, error) {
    if (!this.slots.delete(slot)) return;
    clearTimeout(slot.deadline);
    slot.task?.reject(error);
    void slot.worker.terminate();
    this.drain();
  }

  async close() {
    this.closed = true;
    for (const task of this.queue.splice(0)) {
      clearTimeout(task.expiry);
      task.reject(new Error('Worker TCO cerrado.'));
    }
    await Promise.all([...this.slots].map(slot => {
      clearTimeout(slot.deadline);
      slot.task?.reject(new Error('Worker TCO cerrado.'));
      return slot.worker.terminate();
    }));
  }
}
