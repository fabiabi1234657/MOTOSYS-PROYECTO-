import * as oidc from 'openid-client';

const providerNames = new Set(['google', 'microsoft', 'dev']);
const configuration = new Map();

async function provider(name) {
  if (!providerNames.has(name)) return null;
  const prefix = name.toUpperCase() + '_OIDC_';
  const issuer = process.env[prefix + 'ISSUER'];
  const clientId = process.env[prefix + 'CLIENT_ID'];
  const clientSecret = process.env[prefix + 'CLIENT_SECRET'];
  if (!issuer || !clientId || !process.env.OIDC_PUBLIC_ORIGIN) return null;
  if (!configuration.has(name)) {
    const loading = oidc.discovery(new URL(issuer), clientId, clientSecret, undefined, {
      execute: [oidc.enableNonRepudiationChecks],
    })
      .catch(error => { configuration.delete(name); throw error; });
    configuration.set(name, loading);
  }
  return {
    configuration: await configuration.get(name),
    callback: new URL('/auth/oidc/' + name + '/callback', process.env.OIDC_PUBLIC_ORIGIN),
  };
}

export function oidcHandlers({ redis, db, failure, cookie, matched, createSession, verifyMfa, randomToken, sha }) {
  return {
    async start(name, res, ui = false, mobileChallenge = undefined) {
      const client = await provider(name);
      if (!client) throw failure(404, 'Proveedor OIDC no disponible.');
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const verifier = oidc.randomPKCECodeVerifier();
      const browser = randomToken();
      await redis.set('oidc:request:' + sha(state), JSON.stringify({
        name, verifier, nonce, browser, ui, mobileChallenge,
      }), { EX: 300 });
      res.cookie('__Host-motosys-oidc', browser, {
        secure: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: 300000,
      });
      res.redirect(oidc.buildAuthorizationUrl(client.configuration, {
        redirect_uri: client.callback.href, scope: 'openid email profile', state, nonce,
        code_challenge_method: 'S256', code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      }).href);
    },

    async callback(name, req, res) {
      const client = await provider(name);
      if (!client) throw failure(404, 'Proveedor OIDC no disponible.');
      const { state, code } = req.query;
      if (typeof state !== 'string' || typeof code !== 'string' || state.length > 128 || code.length > 4096) {
        throw failure(400, 'Respuesta OIDC inválida.');
      }
      const key = 'oidc:request:' + sha(state);
      const request = JSON.parse(await redis.get(key) ?? 'null');
      if (!request || request.name !== name || !matched(request.browser, cookie(req, '__Host-motosys-oidc'))
          || !await redis.getDel(key)) {
        throw failure(401, 'Solicitud OIDC caducada o inválida.');
      }
      client.callback.searchParams.set('code', code);
      client.callback.searchParams.set('state', state);
      let claims;
      try {
        const tokens = await oidc.authorizationCodeGrant(client.configuration, client.callback, {
          expectedState: state, expectedNonce: request.nonce, pkceCodeVerifier: request.verifier,
          idTokenExpected: true,
        });
        claims = tokens.claims();
        if (!claims?.iss || !claims?.sub) throw new Error();
      } catch {
        throw failure(401, 'Identidad federada inválida.');
      }
      const { rows: [row] } = await db.query(
        `SELECT u.id, u.role, u.workshop_id, u.totp_secret, u.session_version
         FROM oidc_identities i JOIN users u ON u.id=i.user_id
         WHERE i.issuer=$1 AND i.subject=$2`, [claims.iss, claims.sub],
      );
      if (!row) throw failure(403, 'La identidad federada no está vinculada a una cuenta.');
      if (request.mobileChallenge) {
        const ticket = randomToken();
        await redis.set('oidc:mobile:' + sha(ticket), JSON.stringify({
          userId: row.id, version: row.session_version, challenge: request.mobileChallenge,
        }), { EX: 180 });
        const requiresMfa = row.role !== 'RIDER' || Boolean(row.totp_secret);
        res.redirect('motosys://oidc?ticket=' + ticket + (requiresMfa ? '&mfa=1' : ''));
        return;
      }
      if (row.role === 'RIDER' && !row.totp_secret) {
        const session = await createSession(row, 'web', res, false);
        if (request.ui) { res.redirect('/'); return; }
        return session;
      }
      const challenge = randomToken();
      await redis.set('oidc:mfa:' + sha(challenge), row.id, { EX: 180 });
      res.cookie('__Host-motosys-oidc-mfa', challenge, {
        secure: true, httpOnly: true, sameSite: 'strict', path: '/', maxAge: 180000,
      });
      if (request.ui) { res.redirect('/?oidc=mfa'); return; }
      return { mfaRequired: true };
    },

    async exchangeMobile(ticket, verifier, code, res) {
      const key = 'oidc:mobile:' + sha(ticket);
      const grant = JSON.parse(await redis.get(key) ?? 'null');
      if (!grant || grant.challenge !== sha(verifier)) throw failure(401, 'Solicitud OIDC móvil inválida o caducada.');
      const { rows: [row] } = await db.query(
        'SELECT id, role, workshop_id, totp_secret, session_version FROM users WHERE id=$1', [grant.userId],
      );
      if (!row || row.session_version !== grant.version || !await redis.getDel(key)) {
        throw failure(401, 'Solicitud OIDC móvil inválida o caducada.');
      }
      const mfa = row.role !== 'RIDER' || Boolean(row.totp_secret);
      if (mfa) await verifyMfa(row, code);
      return createSession(row, 'mobile', res, mfa);
    },

    async complete(req, res, code) {
      const challenge = cookie(req, '__Host-motosys-oidc-mfa');
      if (!challenge || !/^[\w-]{43}$/.test(challenge)) throw failure(401, 'Sesión OIDC caducada.');
      const key = 'oidc:mfa:' + sha(challenge);
      const userId = await redis.getDel(key);
      if (!userId) throw failure(401, 'Sesión OIDC caducada.');
      const { rows: [row] } = await db.query(
        'SELECT id, role, workshop_id, totp_secret, session_version FROM users WHERE id=$1', [userId],
      );
      if (!row) throw failure(401, 'Sesión OIDC caducada.');
      await verifyMfa(row, code);
      return createSession(row, 'web', res, true);
    },
  };
}
