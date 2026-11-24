import type { Api } from './api.ts';
import type { Action } from './features.ts';

export type Bike = { id: string; plate: string; make: string; model: string; odometer_km: number };
export type CatalogModel = { make: string; model: string };
export const otherModel = 'Otro modelo';
export type Workshop = { id: string; name: string };
export type BikeInsights = {
  tco?: { tco_cop: number };
  recommendation?: { next_maintenance_date: string; expected_cost_cop: number; source?: string; model_reference?: string | null; recommended_km_interval?: number };
};

export async function loadBikeInsights(api: Api, bike: string): Promise<BikeInsights> {
  const path = '/api/analytics/motorcycles/' + encodeURIComponent(bike);
  const [tco, recommendation] = await Promise.all([
    api<BikeInsights['tco']>(path + '/tco').catch(() => undefined),
    api<BikeInsights['recommendation']>(path + '/recommendation').catch(() => undefined),
  ]);
  return { tco, recommendation };
}

export const shortcuts = [
  { id: 'fuel', action: 'event', label: 'Registrar tanqueo', values: { kind: 'EXPENSE', category: 'combustible', description: 'Tanqueo' } },
  { id: 'oil', action: 'event', label: 'Cambio de aceite', values: { kind: 'MAINTENANCE', category: 'preventivo', description: 'Cambio de aceite' } },
  { id: 'distance', action: 'odo', label: 'Actualizar km', values: {} },
] as const;

export function fixedContext(name: string, defaults: Record<string, string>) {
  return (name === 'motorcycleId' || name === 'workshopId') && Boolean(defaults[name]);
}

export function catalogChoices(catalog: CatalogModel[], make: string) {
  return {
    makes: [...new Set(catalog.map(item => item.make)), otherModel],
    models: [...catalog.filter(item => item.make === make).map(item => item.model), otherModel],
  };
}

export function recommendationSource(value?: Pick<NonNullable<BikeInsights['recommendation']>, 'source' | 'model_reference'>) {
  if (value?.source === 'ml_random_forest') {
    return 'IA personalizada';
  }
  if (value?.source === 'catalog_baseline') {
    return value.model_reference ? 'Referencia fabricante · estimación MotoSys' : 'Referencia general MotoSys';
  }
  return '';
}

export function missingContext(action: Action, values: Record<string, string>) {
  if (action.fields?.some(field => field.name === 'motorcycleId') && !values.motorcycleId) {
    return 'Selecciona o indica una motocicleta.';
  }
  const requiresWorkshop = action.id === 'role'
    ? values.role === 'WORKSHOP_ADMIN'
    : action.fields?.some(field => field.name === 'workshopId' && !field.optional);
  if (requiresWorkshop && !values.workshopId) {
    return 'Selecciona o indica un taller.';
  }
  return '';
}

export function operationValues(action: Action, values: Record<string, string>) {
  return action.id === 'role' && values.role !== 'WORKSHOP_ADMIN' ? { ...values, workshopId: '' } : values;
}

const number = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const date = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export const pesos = (value: number) => '$ ' + number.format(value) + ' COP';
export const distance = (value: number) => number.format(value) + ' km';

export function readableDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : date.format(parsed);
}

const labels: Record<string, string> = {
  plate: 'Placa', make: 'Marca', model: 'Modelo', year: 'Año', odometer_km: 'Odómetro', kilometers: 'Kilómetros',
  kind: 'Tipo', occurred_at: 'Fecha', due_at: 'Vencimiento', description: 'Descripción', category: 'Categoría',
  amount_cop: 'Importe', total_cop: 'Total', tco_cop: 'Costo acumulado', expenses_cop: 'Gastos',
  maintenance_cop: 'Mantenimiento', next_maintenance_date: 'Fecha estimada', expected_cost_cop: 'Costo estimado',
  source: 'Origen', model_reference: 'Modelo de referencia', recommended_km_interval: 'Intervalo orientativo',
  events: 'Eventos', preventive: 'Preventivos', corrective: 'Correctivos', unclassified: 'Sin clasificar',
  name: 'Nombre', title: 'Título', message: 'Mensaje', month: 'Mes', bucket: 'Grupo',
};

type ResultField = { key: string; label: string; value: string; badge?: string };

function displayValue(name: string, value: unknown, reference: unknown): string {
  if (value == null) {
    return '—';
  }
  if (typeof value === 'boolean') {
    return value ? 'Sí' : 'No';
  }
  if (name === 'source' && typeof value === 'string') {
    return recommendationSource({ source: value, model_reference: String(reference ?? '') }) || value;
  }
  if (name.endsWith('_cop') && Number.isFinite(Number(value))) {
    return pesos(Number(value));
  }
  if (typeof value === 'number' && ['odometer_km', 'kilometers', 'recommended_km_interval'].includes(name)) {
    return distance(value);
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) {
    return readableDate(value);
  }
  return String(value);
}

function describeField(key: string, item: unknown, prefix: string, reference: unknown): ResultField[] {
  const name = key.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
  if (['id', 'motorcycle_id', 'workshop_id', 'owner_id'].includes(name)) {
    return [];
  }
  const path = prefix + '/' + key;
  const label = labels[name] ?? name.replaceAll('_', ' ');
  if (item && typeof item === 'object') {
    return resultFields(item, path);
  }
  if (name === 'kind' && (item === 'MAINTENANCE' || item === 'EXPENSE')) {
    return [{ key: path, label, value: item === 'MAINTENANCE' ? 'Mantenimiento' : 'Gasto', badge: item }];
  }
  return [{ key: path, label, value: displayValue(name, item, reference) }];
}

export function resultFields(value: unknown, prefix = ''): ResultField[] {
  if (value == null) {
    return [];
  }
  if (typeof value !== 'object') {
    return [{ key: prefix, label: '', value: String(value) }];
  }
  const record = value as Record<string, unknown>;
  return Object.entries(record).flatMap(([key, item]) => describeField(key, item, prefix, record.model_reference));
}

export function showRegistrationField(name: string, make: string, model: string) {
  if (name === 'make') {
    return make === otherModel;
  }
  if (name === 'model') {
    return make === otherModel || model === otherModel;
  }
  return true;
}

export function availability(settled: boolean) {
  return settled ? 'No disponible' : 'Consultando…';
}

export function predictionStatus(settled: boolean) {
  return settled ? 'Estimación no disponible' : 'Consultando…';
}
