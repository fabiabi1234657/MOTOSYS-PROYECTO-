import type { MotorcycleScope } from '../../../domain/access.ts';
import type { RegistrationResult, VehicleEventInput } from '../in/register-vehicle-event.ts';

export interface VehicleEventStore {
  /**
   * Authorize against the locked motorcycle and insert or replay within one transaction.
   * Compare the stored request fingerprint before returning a replay.
   */
  register(
    actorId: string,
    event: VehicleEventInput,
    authorize: (motorcycle: MotorcycleScope) => boolean,
  ): Promise<RegistrationResult>;
}
