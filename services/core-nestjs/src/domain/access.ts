export type Account =
  | { id: string; role: 'SUPER_ADMIN' | 'RIDER' }
  | { id: string; role: 'WORKSHOP_ADMIN'; workshopId: string };

export interface MotorcycleScope {
  ownerId: string;
  workshopId: string | null;
}

export function canAccessMotorcycle(account: Account, motorcycle: MotorcycleScope): boolean {
  switch (account.role) {
    case 'SUPER_ADMIN':
      return true;
    case 'WORKSHOP_ADMIN':
      return account.workshopId === motorcycle.workshopId;
    case 'RIDER':
      return account.id === motorcycle.ownerId;
  }
}
