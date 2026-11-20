import type { Account } from '../../../domain/access.ts';

export interface VehicleEventInput {
  motorcycleId: string;
  kind: 'MAINTENANCE' | 'EXPENSE';
  category: string;
  description: string;
  amountCop: number;
  occurredAt: string;
  idempotencyKey: string;
}

export type RegistrationResult =
  | { status: 'created' | 'replayed'; eventId: string }
  | { status: 'forbidden' | 'missing' | 'conflict' };

export interface RegisterVehicleEvent {
  execute(actor: Account, input: VehicleEventInput): Promise<RegistrationResult>;
}
