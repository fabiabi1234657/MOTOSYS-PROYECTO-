import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { FormEvent } from 'react';
import { ApiError, createApi } from '../../shared/api.ts';
import type { Account, Session } from '../../shared/api.ts';
import { accountPanels, prepare } from '../../shared/features.ts';
import type { Action, Field } from '../../shared/features.ts';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import './style.css';

const csrf = () => document.cookie.split('; ').find(value => value.startsWith('__Host-motosys-csrf='))?.split('=')[1] ?? '';
const api = createApi('', undefined, csrf);
const roleNames = { RIDER: 'Motociclista', WORKSHOP_ADMIN: 'Administración de taller', SUPER_ADMIN: 'Superadministración' };
const names: Record<string, string> = {
  id: 'ID', plate: 'Placa', make: 'Marca', model: 'Modelo', odometer_km: 'Odómetro (km)',
  kind: 'Tipo', occurred_at: 'Fecha UTC', description: 'Descripción', category: 'Categoría',
  amount_cop: 'Importe COP', tco_cop: 'Total COP', next_maintenance_date: 'Próxima fecha estimada',
  expected_cost_cop: 'Costo estimado COP', workshop_id: 'Taller',
};

type Bike = { id: string; plate: string; make: string; model: string };
type AuthMode = 'login' | 'register' | 'recover' | 'reset' | 'oidc';

const accessActions: Record<AuthMode, Action> = {
  login: {
    id: 'login', label: 'Iniciar sesión', path: '/api/core/auth/login', method: 'POST',
    fields: [
      { name: 'email', label: 'Correo electrónico', type: 'email' },
      { name: 'password', label: 'Contraseña', type: 'password' },
      { name: 'totp', label: 'Código TOTP (si está habilitado)', optional: true },
    ],
  },
  register: {
    id: 'register', label: 'Crear cuenta', path: '/api/core/auth/register', method: 'POST',
    fields: [
      { name: 'email', label: 'Correo electrónico', type: 'email' },
      { name: 'password', label: 'Contraseña (mínimo 15 caracteres)', type: 'password' },
    ],
  },
  recover: {
    id: 'recover', label: 'Enviar enlace', path: '/api/core/auth/password-reset/request', method: 'POST',
    fields: [{ name: 'email', label: 'Correo electrónico', type: 'email' }],
  },
  reset: {
    id: 'reset', label: 'Actualizar contraseña', path: '/api/core/auth/password-reset/confirm', method: 'POST',
    fields: [{ name: 'password', label: 'Contraseña nueva', type: 'password' }],
  },
  oidc: {
    id: 'oidc', label: 'Verificar código', path: '/api/core/auth/oidc/mfa', method: 'POST',
    fields: [{ name: 'code', label: 'Código TOTP' }],
  },
};

function isValidEmail(value: string): boolean {
  if (value.length > 254 || /\s/.test(value)) {
    return false;
  }
  const atIndex = value.indexOf('@');
  if (atIndex <= 0 || atIndex !== value.lastIndexOf('@')) {
    return false;
  }
  const domain = value.slice(atIndex + 1);
  const dotIndex = domain.indexOf('.');
  return dotIndex > 0 && dotIndex < domain.length - 1 && !domain.includes('..');
}

function getAutoComplete(field: Field, actionId: string): string | undefined {
  if (field.type === 'password') {
    return actionId === 'login' ? 'current-password' : 'new-password';
  }
  if (field.type === 'email') {
    return 'email';
  }
  return undefined;
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function getRowKey(record: unknown, index: number): string {
  if (record && typeof record === 'object') {
    const obj = record as Record<string, unknown>;
    const candidate = obj.id ?? obj.event_id ?? obj.eventId ?? obj.plate ?? obj.sku;
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      return String(candidate);
    }
  }
  return 'row-' + JSON.stringify(record) + '-' + index;
}

function getInitialAuthMode(resetToken: string | null): AuthMode {
  if (resetToken) {
    return 'reset';
  }
  if (new URLSearchParams(location.search).get('oidc') === 'mfa') {
    return 'oidc';
  }
  return 'login';
}

function buildAuthPayload(mode: AuthMode, body: object | undefined, resetToken: string | null): object {
  if (mode === 'login') {
    return { ...body, client: 'web' };
  }
  if (mode === 'reset') {
    return { ...body, token: resetToken };
  }
  return { ...body };
}

type FormProps = Readonly<{
  action: Action;
  defaults?: Record<string, string>;
  onRun: (path: string, body?: object) => Promise<void>;
}>;

function renderFieldInput(
  field: Field,
  actionId: string,
  value: string,
  inputProps: { id: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined },
  onChangeValue: (next: string) => void,
  onSelectFile: (next: File | undefined) => void,
) {
  if (field.options) {
    return (
      <select {...inputProps} value={value} onChange={e => onChangeValue(e.target.value)}>
        <option value="">Seleccionar</option>
        {field.options.map(option => <option key={option}>{option}</option>)}
      </select>
    );
  }
  if (field.type === 'file') {
    return <input {...inputProps} type="file" onChange={e => onSelectFile(e.target.files?.[0])} />;
  }
  return (
    <input
      {...inputProps}
      value={value}
      type={field.type ?? 'text'}
      autoComplete={getAutoComplete(field, actionId)}
      onChange={e => onChangeValue(e.target.value)}
    />
  );
}

function Form({ action, defaults = {}, onRun }: FormProps) {
  const [values, setValues] = useState(defaults);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [notice, setNotice] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current) {
      return;
    }
    const multipart = file ? new FormData() : undefined;
    if (file) {
      multipart?.append('file', file);
    }
    const request = prepare(action, values, multipart);
    for (const field of action.fields ?? []) {
      const value = values[field.name] ?? '';
      if (field.type === 'email' && value && !isValidEmail(value)) {
        request.errors[field.name] = 'Escribe un correo válido.';
      }
      if (field.type === 'password' && ['register', 'reset'].includes(action.id) && value.length < 15) {
        request.errors[field.name] = 'Usa al menos 15 caracteres.';
      }
      if (['totp', 'code'].includes(field.name) && value && !/^\d{6}$/.test(value)) {
        request.errors[field.name] = 'Escribe los seis dígitos.';
      }
    }
    setErrors(request.errors);
    if (Object.keys(request.errors).length) {
      setNotice('Revisa los campos marcados.');
      document.getElementById('field-' + Object.keys(request.errors)[0])?.focus();
      return;
    }
    if (action.method === 'DELETE' && !window.confirm('¿Eliminar esta motocicleta?')) {
      return;
    }
    lock.current = true;
    setBusy(true);
    setNotice('');
    try {
      await onRun(request.path, request.body);
      setNotice(action.method ? 'Operación completada.' : 'Consulta completada.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'La solicitud falló.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <form noValidate onSubmit={submit} className="form" aria-busy={busy}>
      {(action.fields ?? []).map(field => {
        const inputProps = {
          id: 'field-' + field.name,
          'aria-invalid': Boolean(errors[field.name]),
          'aria-describedby': errors[field.name] ? 'error-' + field.name : undefined,
        };
        return (
          <div className="field" key={field.name}>
            <label htmlFor={inputProps.id}>{field.label}{field.optional ? ' · opcional' : ''}</label>
            {renderFieldInput(
              field,
              action.id,
              values[field.name] ?? '',
              inputProps,
              next => setValues({ ...values, [field.name]: next }),
              setFile,
            )}
            {errors[field.name] && <small id={'error-' + field.name}>{errors[field.name]}</small>}
          </div>
        );
      })}
      <button type="submit" className="primary" disabled={busy}>{busy ? 'Procesando…' : action.label}</button>
      <p className="status" role="status" aria-live="polite">{notice}</p>
    </form>
  );
}

type ResultsProps = Readonly<{ data: unknown }>;

function Results({ data }: ResultsProps) {
  if (data === undefined) {
    return null;
  }
  const rows = Array.isArray(data) ? data : [data];
  if (!rows.length) {
    return <div className="empty">Sin registros para esta consulta.</div>;
  }
  return (
    <div className="results">
      {rows.map((record, index) => (
        <dl key={getRowKey(record, index)}>
          {Object.entries(record ?? {}).map(([key, value]) => (
            <div key={key}>
              <dt>{names[key] ?? key}</dt>
              <dd>{formatCellValue(value)}</dd>
            </div>
          ))}
        </dl>
      ))}
    </div>
  );
}

function App() {
  const [account, setAccount] = useState<Account>();
  const [checking, setChecking] = useState(true);
  const [screen, setScreen] = useState('vehicles');
  const [choice, setChoice] = useState('');
  const [data, setData] = useState<unknown>();
  const [bikes, setBikes] = useState<Bike[]>([]);
  const [bike, setBike] = useState('');
  const [status, setStatus] = useState('');
  const resetToken = useRef(new URLSearchParams(location.hash.slice(1)).get('token'));
  const [mode, setMode] = useState<AuthMode>(() => getInitialAuthMode(resetToken.current));

  useEffect(() => {
    if (location.hash) {
      history.replaceState(null, '', location.pathname + location.search);
    }
    if (!csrf()) {
      setChecking(false);
      return;
    }
    api<Session>('/api/core/auth/session')
      .then(x => setAccount(x.account))
      .catch(error => {
        if (!(error instanceof ApiError) || error.status !== 401) {
          setStatus('No se pudo consultar la sesión.');
        }
      })
      .finally(() => setChecking(false));
  }, []);

  async function loadBikes() {
    const list = await api<Bike[]>('/api/core/motorcycles');
    setBikes(list);
    setBike(old => (list.some(x => x.id === old) ? old : list[0]?.id ?? ''));
  }

  useEffect(() => {
    if (account) {
      void loadBikes().catch((error: Error) => setStatus(error.message));
    }
  }, [account]);

  function navigate(id: string) {
    setScreen(id);
    setChoice('');
    setData(undefined);
    setStatus('');
  }

  if (checking) {
    return <main className="loading" role="status">Comprobando sesión…</main>;
  }

  if (!account) {
    return (
      <main className="auth-shell">
        <aside className="showcase">
          <Brand />
          <div>
            <p className="eyebrow">TU GARAJE DIGITAL</p>
            <h1>Tu moto,<br />al día.</h1>
            <p>Consulta tu historial y organiza gastos, documentos y próximos servicios.</p>
          </div>
        </aside>
        <section className="signin">
          <div className="mobile-brand"><Brand /></div>
          <p className="eyebrow">ACCESO A MOTOSYS</p>
          <h2>{{ login: 'Iniciar sesión', register: 'Crear cuenta', recover: 'Recuperar contraseña', reset: 'Nueva contraseña', oidc: 'Segundo factor' }[mode]}</h2>
          <Form
            key={mode}
            action={accessActions[mode]}
            onRun={async (path, body) => {
              const payload = buildAuthPayload(mode, body, resetToken.current);
              const result = await api<Session>(path, 'POST', payload);
              if (mode === 'login' || mode === 'oidc') {
                setStatus('');
                setAccount(result.account);
                history.replaceState(null, '', '/');
              }
              if (mode === 'register' || mode === 'reset') {
                setMode('login');
                setStatus('Cuenta actualizada. Inicia sesión.');
              }
              if (mode === 'recover') {
                setStatus('Si la cuenta es elegible, recibirá un enlace de recuperación.');
              }
            }}
          />
          <p role="status" aria-live="polite">{status}</p>
          {mode === 'login' ? (
            <>
              <div className="providers">
                {['Google', 'Microsoft', 'Dev'].map(provider => (
                  <a key={provider} href={'/api/core/auth/oidc/' + provider.toLowerCase() + '/start?ui=1'}>{provider}</a>
                ))}
              </div>
              <div className="switch">
                <button type="button" onClick={() => setMode('register')}>Crear cuenta</button>
                <button type="button" onClick={() => setMode('recover')}>Olvidé mi contraseña</button>
              </div>
            </>
          ) : (
            <button type="button" className="linklike" onClick={() => setMode('login')}>Volver al inicio</button>
          )}
        </section>
      </main>
    );
  }

  const menu = accountPanels(account);
  const panel = menu.find(p => p.id === screen) ?? menu[0];
  const action = panel.actions.find(a => a.id === choice) ?? panel.actions[0];

  async function handleLogout() {
    try {
      await api('/api/core/auth/logout', 'POST');
      setAccount(undefined);
      setData(undefined);
      setBikes([]);
      navigate('vehicles');
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  return (
    <div className="dashboard">
      <a className="skip" href="#content">Saltar al contenido</a>
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Módulos">
          {menu.map((p, index) => (
            <button type="button" key={p.id} aria-current={p.id === panel.id ? 'page' : undefined} onClick={() => navigate(p.id)}>
              <span aria-hidden="true">{['◈', '▤', '◒', '▦', '⚙'][index]}</span>
              {p.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-base">
          <span>{roleNames[account.role]}</span>
          <button type="button" onClick={() => void handleLogout()}>Cerrar sesión</button>
        </div>
      </aside>
      <main id="content" className="content">
        <header>
          <div>
            <p className="eyebrow">PANEL · {roleNames[account.role]}</p>
            <h1>{panel.label}</h1>
          </div>
          <label className="vehicle-picker">
            Motocicleta activa
            <select value={bike} onChange={e => { setBike(e.target.value); setData(undefined); }}>
              <option value="">Seleccionar</option>
              {bikes.map(x => <option key={x.id} value={x.id}>{x.plate} · {x.make} {x.model}</option>)}
            </select>
          </label>
        </header>
        <div className="workspace">
          <nav aria-label="Acciones" className="actions">
            {panel.actions.map(a => (
              <button type="button" aria-pressed={a.id === action.id} key={a.id} onClick={() => { setChoice(a.id); setData(undefined); }}>
                {a.label}
              </button>
            ))}
          </nav>
          <section className="detail">
            <h2>{action.label}</h2>
            <Form
              key={action.id + ':' + bike}
              action={action}
              defaults={{ motorcycleId: bike, workshopId: account.workshopId ?? '', occurredAt: new Date().toISOString().slice(0, 10) }}
              onRun={async (path, body) => {
                const response = await api(path, action.method, body, action.event ? crypto.randomUUID() : undefined, Boolean(action.binary));
                if (action.binary) {
                  const url = URL.createObjectURL(response as Blob);
                  const download = document.createElement('a');
                  download.href = url;
                  download.download = action.binary;
                  download.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                } else {
                  setData(response);
                }
                if (['create', 'edit', 'delete', 'odo'].includes(action.id)) {
                  await loadBikes();
                }
              }}
            />
            <p role="status" aria-live="polite">{status}</p>
            <Results data={data} />
          </section>
        </div>
      </main>
    </div>
  );
}

function Brand() {
  return <div className="brand"><img src="/motosys.svg" alt="" width="42" height="42" /><span>MotoSys</span></div>;
}

createRoot(document.getElementById('root')!).render(<App />);
