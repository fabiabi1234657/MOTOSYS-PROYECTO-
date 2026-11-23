export type Role = 'RIDER' | 'WORKSHOP_ADMIN' | 'SUPER_ADMIN';
export type Account = { id: string; role: Role; workshopId?: string };
export type Session = { account: Account; accessToken?: string };
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export type Api = ReturnType<typeof createApi>;
export function createApi(base = '', token?: string, csrf?: () => string) {
  return async <T = unknown>(path: string, method = 'GET', body?: object, key?: string, binary = false): Promise<T> => {
    const headers = new Headers();
    if (token) headers.set('Authorization', 'Bearer ' + token);
    if (!token && csrf && method !== 'GET') headers.set('X-CSRF-Token', csrf());
    if (key) headers.set('Idempotency-Key', key);
    const multipart = body instanceof FormData;
    if (body && !multipart) headers.set('Content-Type', 'application/json');
    const response = await fetch(base + path, { method, headers,
      credentials: token ? 'omit' : 'same-origin',
      body: body ? multipart ? body : JSON.stringify(body) : undefined });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new ApiError(response.status, typeof data.message === 'string' ? data.message
        : typeof data.detail === 'string' ? data.detail : 'Solicitud rechazada (' + response.status + ').');
    }
    return (binary ? await response.blob() : response.status === 204 ? null : await response.json()) as T;
  };
}
export function serverOrigin(value: string) {
  const uri = new URL(value.trim());
  if (uri.protocol !== 'https:' || uri.username || uri.password || uri.pathname !== '/' || uri.search || uri.hash)
    throw new Error('Usa un origen HTTPS con puerto opcional, sin ruta ni credenciales.');
  return uri.origin;
}
