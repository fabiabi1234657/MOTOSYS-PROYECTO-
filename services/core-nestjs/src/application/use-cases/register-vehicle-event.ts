import { canAccessMotorcycle, type Account } from '../../domain/access.ts';
import type {
  RegisterVehicleEvent as RegisterVehicleEventPort,
  VehicleEventInput,
} from '../ports/in/register-vehicle-event.ts';
import type { VehicleEventStore } from '../ports/out/vehicle-event-store.ts';

export class RegisterVehicleEvent implements RegisterVehicleEventPort {
  private readonly store: VehicleEventStore;

  constructor(store: VehicleEventStore) {
    this.store = store;
  }

  execute(actor: Account, event: VehicleEventInput) {
    return this.store.register(actor.id, event, (motorcycle) => canAccessMotorcycle(actor, motorcycle));
  }
}
