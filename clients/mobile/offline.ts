import { ApiError } from '../shared/api.ts';
import type { Api } from '../shared/api.ts';
export type Pending = { key: string; path: string; body: object; issue?: string };
export async function replay(queue: Pending[], api: Api, save: (rows: Pending[]) => Promise<void>) {
  let pending = [...queue];
  for (const item of queue) {
    if (item.issue) continue;
    try {
      await api(item.path, 'POST', item.body, item.key);
      pending = pending.filter(row => row.key !== item.key);
    } catch (error) {
      if (!(error instanceof ApiError) || ![400,403,404,409,422].includes(error.status)) break;
      pending = pending.map(row => row.key === item.key ? {...row, issue: error.message} : row);
    }
    await save(pending);
  }
  return pending;
}
