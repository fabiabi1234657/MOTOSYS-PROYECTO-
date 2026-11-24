export type Role = 'RIDER' | 'WORKSHOP_ADMIN' | 'SUPER_ADMIN';
export type Account = { id: string; role: Role; workshopId?: string };
export type Session = { account: Account; accessToken?: string };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Api = ReturnType<typeof createApi>;

function buildRequestHeaders(
  method: string,
  body: object | undefined,
  token?: string,
  csrf?: () => string,
  key?: string,
): Headers {
  const headers = new Headers();
  if (token) {
    headers.set('Authorization', 'Bearer ' + token);
  }
  if (!token && csrf && method !== 'GET') {
    headers.set('X-CSRF-Token', csrf());
  }
  if (key) {
    headers.set('Idempotency-Key', key);
  }
  if (body && !(body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  return headers;
}

function serializeBody(body?: object): BodyInit | undefined {
  if (!body) {
    return undefined;
  }
  if (body instanceof FormData) {
    return body;
  }
  return JSON.stringify(body);
}

async function extractErrorMessage(response: Response): Promise<string> {
  const data = await response.json().catch(() => ({}));
  if (typeof data.message === 'string') {
    return data.message;
  }
  if (typeof data.detail === 'string') {
    return data.detail;
  }
  return 'Solicitud rechazada (' + response.status + ').';
}

async function parseResponse<T>(response: Response, binary: boolean): Promise<T> {
  if (binary) {
    return (await response.blob()) as T;
  }
  if (response.status === 204) {
    return null as T;
  }
  return (await response.json()) as T;
}

export function createApi(base = '', token?: string, csrf?: () => string) {
  return async <T = unknown>(
    path: string,
    method = 'GET',
    body?: object,
    key?: string,
    binary = false,
  ): Promise<T> => {
    const headers = buildRequestHeaders(method, body, token, csrf, key);
    const response = await fetch(base + path, {
      method,
      headers,
      credentials: token ? 'omit' : 'same-origin',
      body: serializeBody(body),
    });
    if (!response.ok) {
      throw new ApiError(response.status, await extractErrorMessage(response));
    }
    return parseResponse<T>(response, binary);
  };
}

export function serverOrigin(value: string) {
  const uri = new URL(value.trim());
  if (
    uri.protocol !== 'https:'
    || uri.username
    || uri.password
    || uri.pathname !== '/'
    || uri.search
    || uri.hash
  ) {
    throw new Error('Usa un origen HTTPS con puerto opcional, sin ruta ni credenciales.');
  }
  return uri.origin;
}
