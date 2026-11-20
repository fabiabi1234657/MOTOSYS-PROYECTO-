import { z } from 'zod';
import { catalogSchemas as schemas } from './catalog.mjs';
import { resetConfirm, resetRequest } from './password-reset.mjs';
import { tcoInput } from './tco-pool.mjs';

const email = z.email();
const password = z.string().min(1).max(512);
const paths = {};
const publicAccess = [];
const protectedAccess = [{ bearer: [] }, { webSession: [] }];
const event = z.strictObject({
  kind: z.enum(['MAINTENANCE','EXPENSE']), category: z.string().min(1).max(80),
  description: z.string().min(1).max(500), amountCop: z.int().min(0), occurredAt: z.iso.datetime({ offset: true }),
});
const definitions = [
  ['get', '/health', 'Estado del proceso', 200, null, true],
  ['post', '/auth/register', 'Alta de motociclista', 201, z.strictObject({ email, password }), true],
  ['post', '/auth/login', 'Inicio local', 201, z.strictObject({
    email, password, client: z.enum(['web','mobile']), totp: z.string().length(6).optional(),
  }), true],
  ['post', '/auth/logout', 'Revocar sesión', 201],
  ['get', '/auth/oidc/{provider}/start', 'Inicio federado', 302, null, true],
  ['get', '/auth/oidc/{provider}/callback', 'Retorno federado', 200, null, true],
  ['post', '/auth/oidc/mfa', 'Segundo factor federado', 201, z.strictObject({ code: z.string().regex(/^\d{6}$/) }), true],
  ['post', '/auth/password-reset/request', 'Solicitar recuperación', 202, resetRequest, true],
  ['post', '/auth/password-reset/confirm', 'Cambiar contraseña', 201, resetConfirm, true],
  ['get', '/workshops', 'Consultar talleres autorizados', 200],
  ['post', '/workshops', 'Registrar taller', 201, schemas.workshop],
  ['get', '/workshops/{workshopId}/products', 'Consultar catálogo', 200],
  ['post', '/workshops/{workshopId}/products', 'Registrar producto', 201, schemas.product],
  ['get', '/motorcycles', 'Consultar motocicletas autorizadas', 200],
  ['post', '/motorcycles', 'Registrar motocicleta', 201, schemas.motorcycle],
  ['patch', '/motorcycles/{motorcycleId}', 'Editar motocicleta', 200, schemas.motorcycleUpdate],
  ['delete', '/motorcycles/{motorcycleId}', 'Eliminar motocicleta sin historial', 200],
  ['patch', '/motorcycles/{motorcycleId}/odometer', 'Actualizar odómetro', 200, schemas.odometer],
  ['get', '/motorcycles/{motorcycleId}/events', 'Consultar historial', 200],
  ['post', '/motorcycles/{motorcycleId}/events', 'Registrar evento idempotente', 201, event],
  ['get', '/workshops/{workshopId}/invoices', 'Consultar facturas', 200],
  ['post', '/workshops/{workshopId}/invoices', 'Emitir factura', 201, schemas.invoice],
  ['patch', '/admin/users/{userId}/role', 'Cambiar rol y revocar sesiones', 200, schemas.role],
  ['get', '/admin/audit', 'Consultar auditoría por día UTC', 200],
  ['get', '/admin/cache-metrics', 'Consultar métricas de caché', 200],
  ['post', '/analytics/tco', 'Proyectar el coste por lotes', 201, tcoInput],
];
for (const [method, path, summary, status, body, anonymous] of definitions) {
  const parameters = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name, in: 'path', required: true, schema: name === 'provider'
      ? { type: 'string', enum: ['google','microsoft','dev'] }
      : { type: 'string', format: 'uuid' },
  }));
  if (path.endsWith('/callback')) parameters.push(...['code','state'].map(name => ({
    name, in: 'query', required: true, schema: { type: 'string' },
  })));
  if (path === '/admin/audit') parameters.push({ name: 'day', in: 'query', schema: { type: 'string', format: 'date' } });
  if (path.endsWith('/events') && method === 'post') {
    parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } });
  }
  if (!anonymous && method !== 'get') parameters.push({
    name: 'X-CSRF-Token', in: 'header', description: 'Obligatorio con sesión web por cookie.',
    schema: { type: 'string' },
  });
  const responses = { [status]: { description: 'Operación exitosa' } };
  if (path.endsWith('/events') && method === 'post') responses[200] = { description: 'Reintento idempotente' };
  for (const [code, description] of Object.entries({
    400: 'Datos inválidos', 401: 'Sesión inválida', 403: 'Acceso denegado', 404: 'No encontrado',
    409: 'Conflicto de unicidad o estado', 429: 'Límite de solicitudes', 503: 'Servicio indisponible',
  })) responses[code] = { description };
  (paths[path] ??= {})[method] = {
    summary, security: anonymous ? publicAccess : protectedAccess, parameters, responses,
    ...(body ? { requestBody: { required: true, content: {
      'application/json': { schema: z.toJSONSchema(body, { target: 'draft-2020-12', io: 'input' }) },
    } } } : {}),
  };
}
export const openapi = {
  openapi: '3.1.0',
  info: { title: 'MotoSys Core', version: '1.0.0' },
  paths,
  components: { securitySchemes: {
    bearer: { type: 'http', scheme: 'bearer' },
    webSession: { type: 'apiKey', in: 'cookie', name: '__Host-motosys' },
  } },
};
