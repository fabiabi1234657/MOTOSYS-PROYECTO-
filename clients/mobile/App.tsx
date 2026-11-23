import { useEffect, useRef, useState } from 'react';
import { Alert, Image, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as Picker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useFonts } from 'expo-font';
import { Inter_400Regular, Inter_700Bold } from '@expo-google-fonts/inter';
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono';
import { ApiError, createApi, serverOrigin } from '../shared/api.ts';
import type { Account, Api, Session } from '../shared/api.ts';
import { accountPanels, prepare } from '../shared/features.ts';
import type { Action, Field } from '../shared/features.ts';
import { replay } from './offline';
import type { Pending } from './offline';

const ink = '#0F172A', white = '#F8FAFC', amber = '#F59E0B';
const roles = { RIDER: 'Motociclista', WORKSHOP_ADMIN: 'Administración de taller', SUPER_ADMIN: 'Superadministración' };
type NativeSession = { token: string; account: Account };
type Bike = { id: string; plate: string; make: string };
type Mode = 'login' | 'register' | 'recover' | 'reset' | 'oidc';
type OidcGrant = { ticket: string; requiresMfa: boolean };
const access: Record<Mode, string> = {
  login: 'Iniciar sesión', register: 'Crear cuenta', recover: 'Enviar recuperación',
  reset: 'Cambiar contraseña', oidc: 'Completar acceso federado',
};
const prefs = 'motosys.origin';

type ButtonProps = Readonly<{ label: string; onPress: () => void; prominent?: boolean; disabled?: boolean }>;
function Button({ label, onPress, prominent = false, disabled = false }: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[s.button, prominent && s.primary, disabled && s.disabled]}
    >
      <Text style={s.buttonText}>{label}</Text>
    </Pressable>
  );
}

type InputProps = Readonly<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  secret?: boolean;
  numeric?: boolean;
  error?: string;
}>;
function Input({ label, value, onChange, secret = false, numeric = false, error }: InputProps) {
  return (
    <View>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        style={[s.input, error && s.invalid]}
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        secureTextEntry={secret}
        keyboardType={numeric ? 'number-pad' : 'default'}
        placeholderTextColor="#475569"
      />
      {error && <Text style={s.error}>{error}</Text>}
    </View>
  );
}

function buildLocalAuthRequest(mode: Exclude<Mode, 'oidc'>, auth: Record<string, string>) {
  const { email, password, totp, token } = auth;
  if (mode === 'login') {
    return { route: 'login', payload: { email, password, ...(totp ? { totp } : {}), client: 'mobile' } };
  }
  if (mode === 'register') {
    return { route: 'register', payload: { email, password } };
  }
  if (mode === 'recover') {
    return { route: 'password-reset/request', payload: { email } };
  }
  return { route: 'password-reset/confirm', payload: { token, password } };
}

async function completeOidcExchange(
  api: Api,
  base: string,
  grant: OidcGrant | undefined,
  totp: string | undefined,
): Promise<NativeSession> {
  const saved = JSON.parse((await SecureStore.getItemAsync('motosys.oidc')) ?? 'null');
  if (!saved || saved.base !== base || saved.expires < Date.now() || !grant) {
    throw new Error('Vuelve a iniciar el acceso federado.');
  }
  if (grant.requiresMfa && !/^\d{6}$/.test(totp ?? '')) {
    throw new Error('Escribe los seis dígitos TOTP.');
  }
  const value = await api<Session>('/api/core/auth/oidc/mobile/exchange', 'POST', {
    ticket: grant.ticket,
    verifier: saved.verifier,
    ...(totp ? { code: totp } : {}),
  });
  if (!value.accessToken) {
    throw new Error('No se recibió sesión móvil.');
  }
  const next: NativeSession = { account: value.account, token: value.accessToken };
  await SecureStore.setItemAsync('motosys.session', JSON.stringify({ ...next, base }));
  await SecureStore.deleteItemAsync('motosys.oidc');
  return next;
}

export default function App() {
  const [fonts, fontError] = useFonts({ Inter_400Regular, Inter_700Bold, JetBrainsMono_400Regular });
  const [base, setBase] = useState('');
  const [originText, setOriginText] = useState('');
  const [session, setSession] = useState<NativeSession>();
  const [mode, setMode] = useState<Mode>('login');
  const [grant, setGrant] = useState<OidcGrant>();
  const [auth, setAuth] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);
  const [screen, setScreen] = useState('vehicles');
  const [choice, setChoice] = useState('');
  const [bikes, setBikes] = useState<Bike[]>([]);
  const [bike, setBike] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [result, setResult] = useState<unknown>();
  const lock = useRef(false);
  const serial = useRef(Promise.resolve());

  function enqueue(job: () => Promise<void>) {
    const next = serial.current.then(job);
    serial.current = next.catch(() => {});
    return next;
  }

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(prefs)
      .then(async saved => {
        if (!saved || !alive) return;
        setBase(saved);
        setOriginText(saved);
        const stored = await SecureStore.getItemAsync('motosys.session');
        if (stored && alive) {
          const value = JSON.parse(stored) as NativeSession & { base: string };
          if (value.base !== saved) return;
          try {
            const current = await createApi(saved, value.token)<Session>('/api/core/auth/session');
            setSession({ token: value.token, account: current.account });
          } catch (error) {
            if (!(error instanceof ApiError)) setSession(value);
          }
        }
      })
      .catch(() => setStatus('No se pudo recuperar la configuración.'));
    const unsubscribe = NetInfo.addEventListener(net => setOnline(net.isConnected !== false));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    function receive(url: string) {
      try {
        const link = new URL(url);
        const ticket = link.searchParams.get('ticket') ?? '';
        if (link.protocol === 'motosys:' && link.hostname === 'oidc' && /^[A-Za-z0-9_-]{43}$/.test(ticket)) {
          setGrant({ ticket, requiresMfa: link.searchParams.get('mfa') === '1' });
          setMode('oidc');
        }
      } catch {
        // Ignore malformed deep links.
      }
    }
    void Linking.getInitialURL().then(url => {
      if (url) receive(url);
    });
    const listener = Linking.addEventListener('url', event => receive(event.url));
    return () => listener.remove();
  }, []);

  const queueKey = session ? 'motosys.events.' + encodeURIComponent(base) + '.' + session.account.id : '';
  const api = createApi(base, session?.token);

  async function refreshBikes() {
    const rows = await api<Bike[]>('/api/core/motorcycles');
    setBikes(rows);
    setBike(previous => (rows.some(x => x.id === previous) ? previous : rows[0]?.id ?? ''));
    if (queueKey) {
      await AsyncStorage.setItem(queueKey + '.vehicles', JSON.stringify(rows));
    }
  }

  useEffect(() => {
    if (!queueKey) return;
    let alive = true;
    enqueue(async () => {
      const saved = JSON.parse((await AsyncStorage.getItem(queueKey)) ?? '[]') as Pending[];
      if (alive) setPending(saved);
      if (online) {
        await replay(saved, api, async rows => {
          await AsyncStorage.setItem(queueKey, JSON.stringify(rows));
          if (alive) setPending(rows);
        });
      }
    }).catch(() => {
      if (alive) setStatus('No se pudo sincronizar la cola.');
    });
    if (online) {
      void refreshBikes().catch(error => {
        if (alive) setStatus((error as Error).message);
      });
    } else {
      AsyncStorage.getItem(queueKey + '.vehicles').then(raw => {
        if (alive && raw) {
          const rows = JSON.parse(raw) as Bike[];
          setBikes(rows);
          setBike(rows[0]?.id ?? '');
        }
      });
    }
    return () => {
      alive = false;
    };
  }, [queueKey, online]);

  async function guarded(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setStatus('');
    try {
      await fn();
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function saveOrigin() {
    await guarded(async () => {
      const next = serverOrigin(originText);
      await AsyncStorage.setItem(prefs, next);
      setBase(next);
      setStatus('Servidor guardado.');
    });
  }

  async function startFederated(provider: string) {
    await guarded(async () => {
      if (!base) throw new Error('Guarda primero la URL HTTPS.');
      const bytes = await Crypto.getRandomBytesAsync(32);
      const verifier = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      const challenge = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier);
      await SecureStore.setItemAsync('motosys.oidc', JSON.stringify({ base, verifier, expires: Date.now() + 300000 }));
      await Linking.openURL(base + '/api/core/auth/oidc/' + provider + '/start?challenge=' + challenge);
    });
  }

  async function authenticateLocal(localMode: Exclude<Mode, 'oidc'>) {
    if (localMode !== 'reset' && !auth.email?.trim()) throw new Error('Escribe el correo electrónico.');
    if (localMode !== 'recover' && !auth.password) throw new Error('Escribe la contraseña.');
    if (!base) throw new Error('Guarda primero la URL HTTPS.');
    const { route, payload } = buildLocalAuthRequest(localMode, auth);
    const value = await api<Session>('/api/core/auth/' + route, 'POST', payload);
    if (localMode === 'login' && value.accessToken) {
      const next = { account: value.account, token: value.accessToken };
      await SecureStore.setItemAsync('motosys.session', JSON.stringify({ ...next, base }));
      setSession(next);
    } else if (localMode === 'recover') {
      setStatus('Si la cuenta es elegible, recibirá un enlace.');
    } else {
      setMode('login');
      setStatus('Cuenta actualizada. Inicia sesión.');
    }
    setAuth({});
  }

  async function authenticate() {
    await guarded(async () => {
      if (mode === 'oidc') {
        const next = await completeOidcExchange(api, base, grant, auth.totp);
        setGrant(undefined);
        setAuth({});
        setSession(next);
        return;
      }
      await authenticateLocal(mode);
    });
  }

  async function handleLogout() {
    await guarded(async () => {
      if (online) {
        await api('/api/core/auth/logout', 'POST');
      }
      await SecureStore.deleteItemAsync('motosys.session');
      setSession(undefined);
      setBikes([]);
      setPending([]);
      setResult(undefined);
      setMode('login');
    });
  }

  if (!fonts && !fontError) {
    return <View style={s.shell}><Text accessibilityLiveRegion="polite">Cargando MotoSys…</Text></View>;
  }

  if (!session) {
    return (
      <ScrollView contentContainerStyle={s.shell} keyboardShouldPersistTaps="handled">
        <View style={s.logoLine}>
          <Image source={require('./assets/motosys.png')} style={s.logo} />
          <Text style={s.brand}>MotoSys</Text>
        </View>
        <Text style={s.kicker}>TU GARAJE DIGITAL</Text>
        <Text style={s.title}>{access[mode]}</Text>
        <Input label="Servidor HTTPS (IP LAN y puerto)" value={originText} onChange={setOriginText} />
        <Button label="Guardar servidor" onPress={() => void saveOrigin()} disabled={busy} />
        {mode !== 'reset' && mode !== 'oidc' && (
          <Input label="Correo electrónico" value={auth.email ?? ''} onChange={email => setAuth({ ...auth, email })} />
        )}
        {mode === 'reset' && (
          <Input label="Token del enlace de recuperación" value={auth.token ?? ''} onChange={token => setAuth({ ...auth, token })} />
        )}
        {mode !== 'recover' && mode !== 'oidc' && (
          <Input label="Contraseña" value={auth.password ?? ''} onChange={password => setAuth({ ...auth, password })} secret />
        )}
        {(mode === 'login' || (mode === 'oidc' && grant?.requiresMfa)) && (
          <Input label="Código TOTP" value={auth.totp ?? ''} onChange={totp => setAuth({ ...auth, totp })} numeric />
        )}
        <Button label={busy ? 'Procesando…' : access[mode]} prominent disabled={busy} onPress={() => void authenticate()} />
        {mode === 'login' && (
          <View style={s.wrap}>
            {['Google', 'Microsoft', 'Dev'].map(provider => (
              <Button key={provider} label={provider} disabled={busy} onPress={() => void startFederated(provider.toLowerCase())} />
            ))}
          </View>
        )}
        {(['login', 'register', 'recover', 'reset'] as Mode[])
          .filter(item => item !== mode)
          .map(item => (
            <Button key={item} label={access[item]} onPress={() => { setMode(item); setStatus(''); }} />
          ))}
        <Text accessibilityLiveRegion="polite" style={s.label}>{status}</Text>
      </ScrollView>
    );
  }

  const panels = accountPanels(session.account);
  const panel = panels.find(x => x.id === screen) ?? panels[0];
  const action = panel.actions.find(x => x.id === choice) ?? panel.actions[0];

  return (
    <ScrollView contentContainerStyle={s.shell} keyboardShouldPersistTaps="handled">
      <View style={s.hero}>
        <View style={s.logoLine}>
          <Image source={require('./assets/motosys.png')} style={s.logo} />
          <Text style={s.heroBrand}>MotoSys</Text>
        </View>
        <Text style={s.heroRole}>{roles[session.account.role]}</Text>
      </View>
      <Text style={s.kicker}>{online ? 'EN LÍNEA' : 'SIN CONEXIÓN'} · {pending.length} PENDIENTES</Text>
      {pending.filter(row => row.issue).map(row => (
        <Text style={s.error} key={row.key}>{row.issue} · Registro retenido</Text>
      ))}
      <View style={s.wrap}>
        {panels.map(item => (
          <Button key={item.id} label={item.label} prominent={item.id === panel.id} onPress={() => { setScreen(item.id); setChoice(''); setResult(undefined); }} />
        ))}
      </View>
      <Text style={s.title}>{panel.label}</Text>
      <Text style={s.label}>Motocicleta activa</Text>
      <View style={s.wrap}>
        {bikes.map(item => (
          <Button key={item.id} label={item.plate + ' · ' + item.make} prominent={item.id === bike} onPress={() => { setBike(item.id); setResult(undefined); }} />
        ))}
      </View>
      {bikes.length === 0 && <Text style={s.label}>Sin motocicletas disponibles.</Text>}
      <View style={s.wrap}>
        {panel.actions.map(item => (
          <Button key={item.id} label={item.label} prominent={item.id === action.id} onPress={() => { setChoice(item.id); setResult(undefined); }} />
        ))}
      </View>
      <View style={s.card}>
        <Text style={s.subtitle}>{action.label}</Text>
        <Operation
          key={action.id + ':' + bike}
          action={action}
          defaults={{ motorcycleId: bike, workshopId: session.account.workshopId ?? '', occurredAt: new Date().toISOString().slice(0, 10) }}
          busy={busy}
          onRun={(path, body) => guarded(async () => {
            if (action.event && body) {
              const entry = { key: Crypto.randomUUID(), path, body };
              await enqueue(async () => {
                const saved = JSON.parse((await AsyncStorage.getItem(queueKey)) ?? '[]') as Pending[];
                const next = [...saved, entry];
                await AsyncStorage.setItem(queueKey, JSON.stringify(next));
                setPending(next);
                const remaining = online
                  ? await replay(next, api, async rows => {
                    await AsyncStorage.setItem(queueKey, JSON.stringify(rows));
                    setPending(rows);
                  })
                  : next;
                setStatus(remaining.some(item => item.key === entry.key) ? 'Registro pendiente de sincronización.' : 'Registro sincronizado.');
              });
              return;
            }
            if (!online) throw new Error('Esta operación requiere conexión.');
            if (action.binary) {
              const file = await FileSystem.downloadAsync(base + path, (FileSystem.cacheDirectory ?? '') + action.binary, {
                headers: { Authorization: 'Bearer ' + session.token },
              });
              if (file.status !== 200) throw new Error('No se pudo descargar el archivo (' + file.status + ').');
              await Sharing.shareAsync(file.uri);
            } else {
              setResult(await api(path, action.method, body));
            }
            if (['create', 'edit', 'delete', 'odo'].includes(action.id)) await refreshBikes();
            setStatus('Operación completada.');
          })}
        />
        <Text style={s.label} accessibilityLiveRegion="polite">{status}</Text>
        {result !== undefined && (Array.isArray(result) && !result.length
          ? <Text style={s.label}>Sin registros.</Text>
          : <Text selectable style={s.results}>{JSON.stringify(result, null, 2)}</Text>)}
      </View>
      <Button label="Cerrar sesión" disabled={busy} onPress={() => void handleLogout()} />
    </ScrollView>
  );
}

function renderOperationField(
  field: Field,
  value: string,
  error: string | undefined,
  file: Picker.DocumentPickerAsset | undefined,
  onChangeValue: (next: string) => void,
  onPickFile: () => void,
) {
  if (field.options) {
    return (
      <View key={field.name}>
        <Text style={s.label}>{field.label}</Text>
        <View style={s.wrap}>
          {field.options.map(option => (
            <Button key={option} label={option} prominent={option === value} onPress={() => onChangeValue(option)} />
          ))}
        </View>
        {error && <Text style={s.error}>{error}</Text>}
      </View>
    );
  }
  if (field.type === 'file') {
    return (
      <View key={field.name}>
        <Button label={file?.name ?? 'Seleccionar archivo'} onPress={onPickFile} />
        {error && <Text style={s.error}>{error}</Text>}
      </View>
    );
  }
  const label = field.type === 'date' ? field.label + ' (AAAA-MM-DD)' : field.label;
  return (
    <Input
      key={field.name}
      label={label}
      value={value}
      onChange={onChangeValue}
      numeric={field.type === 'number'}
      error={error}
    />
  );
}

type OperationProps = Readonly<{
  action: Action;
  defaults: Record<string, string>;
  busy: boolean;
  onRun: (path: string, body?: object) => void;
}>;

function Operation({ action, defaults, busy, onRun }: OperationProps) {
  const [values, setValues] = useState(defaults);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [file, setFile] = useState<Picker.DocumentPickerAsset>();

  function submit() {
    const multipart = file ? new FormData() : undefined;
    if (file && multipart) {
      multipart.append('file', { uri: file.uri, type: file.mimeType ?? 'application/octet-stream', name: file.name } as unknown as Blob);
    }
    const request = prepare(action, values, multipart);
    setErrors(request.errors);
    if (Object.keys(request.errors).length) return;
    if (action.method === 'DELETE') {
      Alert.alert('Eliminar motocicleta', '¿Confirmas esta operación?', [
        { text: 'Cancelar' },
        { text: 'Eliminar', onPress: () => onRun(request.path, request.body) },
      ]);
    } else {
      onRun(request.path, request.body);
    }
  }

  return (
    <View style={s.form}>
      {action.fields?.map(field =>
        renderOperationField(
          field,
          values[field.name] ?? '',
          errors[field.name],
          file,
          next => setValues({ ...values, [field.name]: next }),
          () => {
            void Picker.getDocumentAsync().then(picked => {
              if (!picked.canceled) setFile(picked.assets[0]);
            });
          },
        ),
      )}
      <Button label={busy ? 'Procesando…' : action.label} prominent disabled={busy} onPress={submit} />
    </View>
  );
}

const s = StyleSheet.create({
  shell: { paddingHorizontal: 18, paddingTop: 48, paddingBottom: 40, backgroundColor: white, gap: 14, flexGrow: 1 },
  hero: { backgroundColor: ink, padding: 18, borderRadius: 14, gap: 4 },
  heroBrand: { color: amber, fontSize: 27, fontFamily: 'Inter_700Bold' },
  heroRole: { color: white, fontSize: 14 },
  brand: { color: ink, fontSize: 28, fontFamily: 'Inter_700Bold' },
  kicker: { color: '#475569', fontFamily: 'JetBrainsMono_400Regular', fontSize: 12, letterSpacing: 1.4 },
  title: { color: ink, fontSize: 30, fontFamily: 'Inter_700Bold' },
  subtitle: { color: ink, fontSize: 21, fontFamily: 'Inter_700Bold' },
  label: { color: ink, fontFamily: 'Inter_700Bold', marginBottom: 4 },
  input: { borderWidth: 1, borderColor: '#8493a7', minHeight: 46, borderRadius: 8, paddingHorizontal: 12, color: ink, backgroundColor: '#fff' },
  button: { borderWidth: 1, borderColor: '#9aa9ba', borderRadius: 8, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, justifyContent: 'center' },
  primary: { backgroundColor: amber, borderColor: amber },
  disabled: { opacity: 0.5 },
  buttonText: { fontFamily: 'Inter_700Bold', color: ink },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#d9e2eb', padding: 14, gap: 12 },
  form: { gap: 12 },
  logoLine: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { width: 40, height: 40 },
  invalid: { borderColor: '#a31528' },
  error: { color: '#a31528' },
  results: { fontFamily: 'JetBrainsMono_400Regular', color: ink },
});
