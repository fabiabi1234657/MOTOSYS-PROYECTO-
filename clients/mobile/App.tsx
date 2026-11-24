import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, Animated, BackHandler, Easing, Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { initialWindowMetrics, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { availability, catalogChoices, distance, fixedContext, loadBikeInsights, missingContext, operationValues, otherModel, pesos, readableDate, recommendationSource, resultFields, shortcuts, showRegistrationField, predictionStatus } from '../shared/garage.ts';
import type { Bike, BikeInsights, CatalogModel, Workshop } from '../shared/garage.ts';
import { replay } from './offline';
import type { Pending } from './offline';

const ink = '#0F172A', white = '#F8FAFC', amber = '#F59E0B';
const roles = { RIDER: 'Motociclista', WORKSHOP_ADMIN: 'Administración de taller', SUPER_ADMIN: 'Superadministración' };
type NativeSession = { token: string; account: Account };
type Mode = 'login' | 'register' | 'recover' | 'reset' | 'oidc';
type OidcGrant = { ticket: string; requiresMfa: boolean };
const access: Record<Mode, string> = {
  login: 'Iniciar sesión', register: 'Crear cuenta', recover: 'Enviar recuperación',
  reset: 'Cambiar contraseña', oidc: 'Completar acceso federado',
};
const prefs = 'motosys.origin';
const sections: Record<string, { label: string; icon: string }> = {
  vehicles: { label: 'Garaje', icon: '⌂' },
  documents: { label: 'Alertas', icon: '◇' },
  analytics: { label: 'Datos', icon: '▥' },
  workshop: { label: 'Taller', icon: '⚙' },
  admin: { label: 'Admin', icon: '◈' },
  account: { label: 'Cuenta', icon: '○' },
};

function ScreenTransition({ children }: Readonly<{ children: React.ReactNode }>) {
  const progress = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(reduced => {
      if (!mounted || reduced) {
        return;
      }
      progress.setValue(0);
      Animated.timing(progress, {
        toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true,
      }).start();
    }).catch(() => {});
    return () => {
      mounted = false;
      progress.stopAnimation();
    };
  }, [progress]);
  return <Animated.View style={{ gap: 16, opacity: progress, transform: [
    { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
  ] }}>{children}</Animated.View>;
}

function Row({ label, detail, selected, onPress }: Readonly<{
  label: string; detail?: string; selected?: boolean; onPress: () => void;
}>) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
      android_ripple={{ color: '#E9DCC1' }}
      style={({ pressed }) => [s.row, selected && s.selectedRow, pressed && s.pressed]}>
      <View style={s.rowCopy}>
        <Text style={s.label}>{label}</Text>
        {detail && <Text style={s.muted}>{detail}</Text>}
      </View>
      <Text accessible={false} style={s.arrow}>{selected ? '✓' : '›'}</Text>
    </Pressable>
  );
}

type ButtonProps = Readonly<{ label: string; onPress: () => void; prominent?: boolean; disabled?: boolean }>;
function Button({ label, onPress, prominent = false, disabled = false }: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.button, prominent && s.primary, pressed && s.pressed, disabled && s.disabled]}
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
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <MobileApp />
    </SafeAreaProvider>
  );
}

function MobileApp() {
  const insets = useSafeAreaInsets();
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
  const [showServer, setShowServer] = useState(false);
  const [showTotp, setShowTotp] = useState(false);
  const [bikes, setBikes] = useState<Bike[]>([]);
  const [bike, setBike] = useState('');
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [workshop, setWorkshop] = useState('');
  const [shortcut, setShortcut] = useState('');
  const [insights, setInsights] = useState<BikeInsights>();
  const [insightRevision, setInsightRevision] = useState(0);
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
        if (!saved || !alive) {
          return;
        }
        setBase(saved);
        setOriginText(saved);
        const stored = await SecureStore.getItemAsync('motosys.session');
        if (stored && alive) {
          const value = JSON.parse(stored) as NativeSession & { base: string };
          if (value.base !== saved) {
            return;
          }
          try {
            const current = await createApi(saved, value.token)<Session>('/api/core/auth/session');
            setSession({ token: value.token, account: current.account });
          } catch (error) {
            if (!(error instanceof ApiError)) {
              setSession(value);
            }
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
      if (url) {
        receive(url);
      }
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
    if (!queueKey) {
      return;
    }
    let alive = true;
    enqueue(async () => {
      const saved = JSON.parse((await AsyncStorage.getItem(queueKey)) ?? '[]') as Pending[];
      if (alive) {
        setPending(saved);
      }
      if (online) {
        await replay(saved, api, async rows => {
          await AsyncStorage.setItem(queueKey, JSON.stringify(rows));
          if (alive) {
            setPending(rows);
          }
        });
        if (alive && saved.length) {
          setInsightRevision(previous => previous + 1);
        }
      }
    }).catch(() => {
      if (alive) {
        setStatus('No se pudo sincronizar la cola.');
      }
    });
    if (online) {
      void refreshBikes().catch(error => {
        if (alive) {
          setStatus((error as Error).message);
        }
      });
    } else {
      AsyncStorage.getItem(queueKey + '.vehicles').then(raw => {
        if (alive && raw) {
          const rows = JSON.parse(raw) as Bike[];
          setBikes(rows);
          setBike(previous => rows.some(item => item.id === previous) ? previous : rows[0]?.id ?? '');
        }
      });
    }
    return () => {
      alive = false;
    };
  }, [queueKey, online]);

  useEffect(() => {
    if (!(session && online)) {
      setCatalog([]);
      return;
    }
    let current = true;
    void api<CatalogModel[]>('/api/analytics/catalog')
      .then(rows => { if (current) { setCatalog(rows); } })
      .catch(() => {});
    return () => { current = false; };
  }, [session, online]);

  async function refreshWorkshops(preferred?: string) {
    const rows = await api<Workshop[]>('/api/core/workshops');
    setWorkshops(rows);
    setWorkshop(current => preferred || (rows.some(row => row.id === current) ? current : rows[0]?.id ?? ''));
  }

  useEffect(() => {
    if (session && online && session.account.role !== 'RIDER') {
      void refreshWorkshops(session.account.workshopId).catch((error: Error) => setStatus(error.message));
    }
  }, [session, online]);

  useEffect(() => {
    setInsights(undefined);
    if (!session || !online || !bike) {
      return;
    }
    let current = true;
    void loadBikeInsights(api, bike).then(value => { if (current) setInsights(value); });
    return () => { current = false; };
  }, [session, online, bike, insightRevision]);

  async function guarded(fn: () => Promise<void>) {
    if (lock.current) {
      return;
    }
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
      if (!base) {
        throw new Error('Guarda primero la URL HTTPS.');
      }
      const bytes = await Crypto.getRandomBytesAsync(32);
      const verifier = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      const challenge = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier);
      await SecureStore.setItemAsync('motosys.oidc', JSON.stringify({ base, verifier, expires: Date.now() + 300000 }));
      await Linking.openURL(base + '/api/core/auth/oidc/' + provider + '/start?challenge=' + challenge);
    });
  }

  async function authenticateLocal(localMode: Exclude<Mode, 'oidc'>) {
    if (localMode !== 'reset' && !auth.email?.trim()) {
      throw new Error('Escribe el correo electrónico.');
    }
    if (localMode !== 'recover' && !auth.password) {
      throw new Error('Escribe la contraseña.');
    }
    if (!base) {
      throw new Error('Guarda primero la URL HTTPS.');
    }
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
      setBike('');
      setWorkshops([]);
      setWorkshop('');
      setPending([]);
      setResult(undefined);
      setMode('login');
      navigate('vehicles');
    });
  }

  function navigate(next: string, action = '', preset = '') {
    setShortcut(preset);
    setScreen(next);
    setChoice(action);
    setResult(undefined);
    setStatus('');
  }

  useEffect(() => {
    if (!session || (!choice && screen === 'vehicles')) {
      return;
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (lock.current) {
        return true;
      }
      navigate(choice ? screen : 'vehicles');
      return true;
    });
    return () => subscription.remove();
  }, [session, choice, screen]);

  if (!fonts && !fontError) {
    return <View style={s.shell}><Text accessibilityLiveRegion="polite">Cargando MotoSys…</Text></View>;
  }

  if (!session) {
    return (
      <KeyboardAvoidingView style={[s.app, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={[s.shell, { paddingBottom: 24 + insets.bottom }]} keyboardShouldPersistTaps="handled">
          <View style={s.logoLine}>
            <Image source={require('./assets/motosys.png')} style={s.logo} />
            <Text style={s.brand}>MotoSys</Text>
          </View>
          <Text accessibilityRole="header" style={s.title}>{access[mode]}</Text>
          {(!base || showServer) && (
            <View style={s.card}>
              <Input label="Servidor HTTPS" value={originText} onChange={setOriginText} />
              <Button label="Guardar servidor" onPress={() => void saveOrigin()} disabled={busy} />
            </View>
          )}
          {mode !== 'reset' && mode !== 'oidc' && (
            <Input label="Correo electrónico" value={auth.email ?? ''} onChange={email => setAuth({ ...auth, email })} />
          )}
          {mode === 'reset' && (
            <Input label="Token del enlace de recuperación" value={auth.token ?? ''} onChange={token => setAuth({ ...auth, token })} />
          )}
          {mode !== 'recover' && mode !== 'oidc' && (
            <Input label="Contraseña" value={auth.password ?? ''} onChange={password => setAuth({ ...auth, password })} secret />
          )}
          {mode === 'login' && !showTotp && <Row label="Usar código de verificación" onPress={() => setShowTotp(true)} />}
          {((mode === 'login' && showTotp) || (mode === 'oidc' && grant?.requiresMfa)) && (
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
              <Row key={item} label={access[item]} onPress={() => { setMode(item); setStatus(''); }} />
            ))}
          {base && <Row label={showServer ? 'Ocultar servidor' : 'Configurar servidor'} onPress={() => setShowServer(!showServer)} />}
          {!!status && <Text accessibilityLiveRegion="polite" style={s.feedback}>{status}</Text>}
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  const panels = accountPanels(session.account);
  const panel = panels.find(item => item.id === screen) ?? panels[0];
  const action = panel.actions.find(item => item.id === choice);
  const activeShortcut = shortcuts.find(item => item.id === shortcut);
  const activeBike = bikes.find(item => item.id === bike);
  const needsBike = action?.fields?.some(field => field.name === 'motorcycleId');
  const showWorkshop = panel.id === 'workshop' || panel.id === 'admin';
  const canRegisterBike = panel.actions.some(item => item.id === 'create');

  return (
    <KeyboardAvoidingView style={[s.app, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar barStyle="dark-content" />
      <View style={s.header}>
        <View style={s.logoLine}>
          <Image source={require('./assets/motosys.png')} style={s.mark} />
          <Text style={s.brand}>MotoSys</Text>
        </View>
        <Text accessibilityLiveRegion="polite" style={[s.connection, !online && s.offline]}>
          {online ? 'En línea' : 'Sin conexión'}{pending.length ? ' · ' + pending.length : ''}
        </Text>
      </View>
      <ScrollView key={[screen, choice, shortcut].join(':')} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <ScreenTransition>
          {screen === 'account' && (
            <>
              <Text style={s.title} accessibilityRole="header">Mi cuenta</Text>
              <View style={s.card}>
                <Text style={s.subtitle}>{roles[session.account.role]}</Text>
                <Text style={s.muted}>{pending.length} registros pendientes de sincronización</Text>
                {pending.filter(row => row.issue).map(row => (
                  <Text style={s.error} key={row.key}>{row.issue} · Registro retenido</Text>
                ))}
                <Button label="Cerrar sesión" disabled={busy} onPress={() => void handleLogout()} />
              </View>
            </>
          )}
          {screen !== 'account' && action && (
            <>
              <Row label={'Volver a ' + sections[panel.id].label} onPress={() => { if (!lock.current) { navigate(panel.id); } }} />
              <Text style={s.title} accessibilityRole="header">{activeShortcut?.label ?? action.label}</Text>
              {needsBike && bikes.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
                  {bikes.map(item => <Row key={item.id} label={item.plate} selected={bike === item.id}
                    onPress={() => { if (!lock.current) { setBike(item.id); setResult(undefined); setStatus(''); } }} />)}
                </ScrollView>
              )}
              {showWorkshop && workshops.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
                  {workshops.map(item => <Row key={item.id} label={item.name} selected={workshop === item.id}
                    onPress={() => { if (!lock.current) { setWorkshop(item.id); setResult(undefined); } }} />)}
                </ScrollView>
              )}
              <View style={s.card}>
                <Operation
                  key={[action.id, bike, workshop, shortcut].join(':')}
                  action={action}
                  catalog={catalog}
                  defaults={{ motorcycleId: bike, workshopId: workshop, occurredAt: new Date().toISOString().slice(0, 10), ...activeShortcut?.values }}
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
                        setInsightRevision(previous => previous + 1);
                        setStatus(remaining.some(item => item.key === entry.key) ? 'Registro pendiente de sincronización.' : 'Registro sincronizado.');
                      });
                      return;
                    }
                    if (!online) {
                      throw new Error('Esta operación requiere conexión.');
                    }
                    if (action.binary) {
                      const file = await FileSystem.downloadAsync(base + path, (FileSystem.cacheDirectory ?? '') + action.binary, {
                        headers: { Authorization: 'Bearer ' + session.token },
                      });
                      if (file.status !== 200) {
                        throw new Error('No se pudo descargar el archivo (' + file.status + ').');
                      }
                      await Sharing.shareAsync(file.uri);
                    } else {
                      setResult(await api(path, action.method, body));
                    }
                    if (action.id === 'shop-add') {
                      await refreshWorkshops();
                    }
                    if (['create', 'edit', 'delete', 'odo'].includes(action.id)) {
                      await refreshBikes();
                    }
                    setStatus('Operación completada.');
                  })}
                />
              </View>
              {result !== undefined && <Result value={result} />}
            </>
          )}
          {screen !== 'account' && !action && (
            <>
              <Text style={s.title} accessibilityRole="header">{panel.id === 'vehicles' ? 'Mi garaje' : panel.label}</Text>
              {panel.id === 'vehicles' && (
                <GarageSummary bike={activeBike} insights={insights} online={online}
                  onRegister={canRegisterBike ? () => navigate(panel.id, 'create') : undefined} />
              )}
              {panel.id === 'vehicles' && activeBike && (
                <View style={s.wrap}>
                  {shortcuts.map(item => <Button key={item.id} label={item.label} onPress={() => navigate(panel.id, item.action, item.id)} />)}
                </View>
              )}
              {panel.id === 'vehicles' && bikes.length > 1 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
                  {bikes.map(item => <Row key={item.id} label={item.plate} detail={item.make} selected={bike === item.id}
                    onPress={() => setBike(item.id)} />)}
                </ScrollView>
              )}
              <View style={s.actionList}>
                {panel.actions.map(item => <Row key={item.id} label={item.label} onPress={() => navigate(panel.id, item.id)} />)}
              </View>
            </>
          )}
          {!!status && <Text style={s.feedback} accessibilityLiveRegion="polite">{status}</Text>}
        </ScreenTransition>
      </ScrollView>
      <View style={[s.tabBar, { paddingBottom: 8 + insets.bottom }]} accessibilityRole="tablist">
        {[...panels.map(item => item.id), 'account'].map(id => (
          <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: screen === id, disabled: busy }}
            disabled={busy} onPress={() => navigate(id)} style={({ pressed }) => [s.tab, pressed && s.pressed]}>
            <View style={[s.tabIcon, screen === id && s.activeTab]}>
              <Text accessible={false} style={s.icon}>{sections[id].icon}</Text>
            </View>
            <Text style={[s.tabLabel, screen === id && s.activeTabLabel]}>{sections[id].label}</Text>
          </Pressable>
        ))}
      </View>
    </KeyboardAvoidingView>
  );
}

function GarageSummary({ bike, insights, online, onRegister }: Readonly<{
  bike?: Bike; insights?: BikeInsights; online: boolean; onRegister?: () => void;
}>) {
  const settled = Boolean(insights) || !online;
  const prediction = insights?.recommendation;
  const source = recommendationSource(prediction);
  return (
    <View style={s.garage}>
      <Text style={s.garageCaption}>MI MOTO</Text>
      <Text style={s.garagePlate}>{bike?.plate ?? 'Sin motocicletas'}</Text>
      {!bike && onRegister && <Button label="Registrar motocicleta" prominent onPress={onRegister} />}
      {bike && (
        <>
          <Text style={s.garageCaption}>{bike.make} {bike.model}</Text>
          <View style={s.garageMetrics}>
            <Text style={s.garageCaption}>Odómetro actual</Text>
            <Text style={s.garageValue}>{bike.odometer_km == null ? 'No disponible' : distance(bike.odometer_km)}</Text>
            <Text style={s.garageCaption}>Gasto acumulado</Text>
            <Text style={s.garageValue}>{insights?.tco ? pesos(insights.tco.tco_cop) : availability(settled)}</Text>
            <Text style={s.garageCaption}>Próximo mantenimiento estimado</Text>
            <Text style={s.garageValue}>{prediction
              ? readableDate(prediction.next_maintenance_date) + ' · ' + pesos(prediction.expected_cost_cop)
              : predictionStatus(settled)}</Text>
            {!!source && <Text style={s.garageCaption}>{source}</Text>}
          </View>
        </>
      )}
    </View>
  );
}

function Result({ value }: Readonly<{ value: unknown }>) {
  const rows = Array.isArray(value) ? value : [value];
  if (!rows.length || value == null) {
    return <Text style={s.feedback}>Sin registros.</Text>;
  }
  return <View style={s.form}>{rows.map((item, index) => (
    <View key={index} style={s.card}>
      {resultFields(item).map(field => (
        <View key={field.key} style={s.resultField}>
          {!!field.label && <Text style={s.muted}>{field.label}</Text>}
          <Text selectable={!field.badge}
            style={[s.resultValue, field.badge && s.badge, field.badge === 'EXPENSE' && s.expenseBadge]}>{field.value}</Text>
        </View>
      ))}
    </View>
  ))}</View>;
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

function CatalogPicker({ label, value, options, onPick }: Readonly<{
  label: string; value: string; options: string[]; onPick: (value: string) => void;
}>) {
  const [visible, setVisible] = useState(false);
  return (
    <>
      <Row label={label} detail={value || 'Seleccionar'} onPress={() => setVisible(true)} />
      <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setVisible(false)}>
        <View style={s.pickerShell}>
          <Button label="Cerrar" onPress={() => setVisible(false)} />
          <ScrollView contentContainerStyle={s.form}>
            {options.map(option => <Row key={option} label={option} selected={option === value} onPress={() => {
              onPick(option);
              setVisible(false);
            }} />)}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

type OperationProps = Readonly<{
  action: Action;
  catalog: CatalogModel[];
  defaults: Record<string, string>;
  busy: boolean;
  onRun: (path: string, body?: object) => void;
}>;

function Operation({ action, catalog, defaults, busy, onRun }: OperationProps) {
  const [values, setValues] = useState(defaults);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [file, setFile] = useState<Picker.DocumentPickerAsset>();

  const [catalogMake, setCatalogMake] = useState('');
  const [catalogModel, setCatalogModel] = useState('');
  const useCatalog = action.id === 'create' && catalog.length > 0;
  const choices = catalogChoices(catalog, catalogMake);
  const contextMessage = missingContext(action, values);

  function submit() {
    if (contextMessage) { return; }
    const multipart = file ? new FormData() : undefined;
    if (file && multipart) {
      multipart.append('file', { uri: file.uri, type: file.mimeType ?? 'application/octet-stream', name: file.name } as unknown as Blob);
    }
    const request = prepare(action, operationValues(action, values), multipart);
    setErrors(request.errors);
    if (Object.keys(request.errors).length) {
      return;
    }
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
      {useCatalog && <View style={s.form}>
        <CatalogPicker label="Marca" value={catalogMake} options={choices.makes} onPick={make => {
          setCatalogMake(make);
          setCatalogModel('');
          setValues(previous => ({ ...previous, make: make === otherModel ? '' : make, model: '' }));
        }} />
        {!!catalogMake && catalogMake !== otherModel && (
          <CatalogPicker label="Modelo" value={catalogModel} options={choices.models} onPick={model => {
            setCatalogModel(model);
            setValues(previous => ({ ...previous, model: model === otherModel ? '' : model }));
          }} />
        )}
        {(errors.make || errors.model) && <Text style={s.error}>{errors.make ?? errors.model}</Text>}
      </View>}
      {action.fields?.filter(field => !fixedContext(field.name, defaults)
        && (!useCatalog || showRegistrationField(field.name, catalogMake, catalogModel))).map(field =>
        renderOperationField(
          field,
          values[field.name] ?? '',
          errors[field.name],
          file,
          next => setValues({ ...values, [field.name]: next }),
          () => {
            void Picker.getDocumentAsync().then(picked => {
              if (!picked.canceled) {
                setFile(picked.assets[0]);
              }
            });
          },
        ),
      )}
      {!!contextMessage && <Text style={s.feedback}>{contextMessage}</Text>}
      <Button label={busy ? 'Procesando…' : action.label} prominent disabled={busy || Boolean(contextMessage)} onPress={submit} />
    </View>
  );
}

const s = StyleSheet.create({
  app: { flex: 1, backgroundColor: '#F7F5EF' },
  shell: { padding: 24, gap: 14, flexGrow: 1 },
  header: { minHeight: 64, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  content: { padding: 20, paddingBottom: 32 },
  mark: { width: 32, height: 32, borderRadius: 9 },
  connection: { color: '#215447', backgroundColor: '#DEEBE4', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, fontSize: 12 },
  offline: { color: '#74410C', backgroundColor: '#FBE8C7' },
  garage: { backgroundColor: ink, borderRadius: 24, padding: 22, gap: 12 },
  garageCaption: { color: '#CCDAEC', fontFamily: 'Inter_400Regular', fontSize: 13 },
  garageMetrics: { gap: 5, paddingTop: 8 },
  garageValue: { color: white, fontFamily: 'Inter_700Bold', marginBottom: 7, fontSize: 16 },
  badge: { alignSelf: 'flex-start', color: '#215447', backgroundColor: '#DEEBE4', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4 },
  expenseBadge: { color: '#74410C', backgroundColor: '#FBE8C7' },
  garagePlate: { color: white, fontFamily: 'Inter_700Bold', fontSize: 32 },
  row: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, backgroundColor: '#FFF' },
  rowCopy: { flexShrink: 1 },
  selectedRow: { backgroundColor: '#F9E6BD' },
  arrow: { color: '#805312', fontSize: 21 },
  actionList: { gap: 6 },
  chips: { gap: 8 },
  muted: { color: '#4B5563', fontFamily: 'Inter_400Regular', fontSize: 13 },
  pressed: { opacity: 0.72 },
  feedback: { padding: 12, borderRadius: 12, color: ink, backgroundColor: '#EBE8DE' },
  tabBar: { backgroundColor: '#FFF', borderTopWidth: 1, borderColor: '#E5E1D7', flexDirection: 'row', paddingTop: 7, paddingHorizontal: 6 },
  tab: { flex: 1, alignItems: 'center', minHeight: 50, gap: 3 },
  tabIcon: { minWidth: 38, height: 29, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  activeTab: { backgroundColor: '#F9E6BD' },
  icon: { color: ink, fontSize: 19, lineHeight: 23 },
  tabLabel: { color: '#4B5563', fontSize: 11 },
  activeTabLabel: { color: ink, fontFamily: 'Inter_700Bold' },
  pickerShell: { flex: 1, gap: 10, padding: 20, paddingTop: 48, paddingBottom: 48, backgroundColor: '#F7F5EF' },
  resultField: { gap: 3 },
  resultValue: { color: ink, fontFamily: 'Inter_400Regular', fontSize: 15 },
  brand: { color: ink, fontSize: 28, fontFamily: 'Inter_700Bold' },
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
});
