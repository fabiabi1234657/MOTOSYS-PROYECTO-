import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import test from 'node:test';
import { oidcHandlers } from '../src/oidc.mjs';

test('OIDC valida firma, nonce, PKCE y vinculación local', async t => {
  const issuer = 'https://issuer.example.invalid';
  const origin = 'https://motosys.example.invalid';
  const values = {
    DEV_OIDC_ISSUER: issuer, DEV_OIDC_CLIENT_ID: 'motosys-test',
    DEV_OIDC_CLIENT_SECRET: 'fixture-secret', OIDC_PUBLIC_ORIGIN: origin,
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  let redirect;
  let browser;
  let corrupt = false;
  const res = { cookie: (_, value) => { browser = value; }, redirect: value => { redirect = new URL(value); } };
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, issuer);
    if (url.pathname.includes('.well-known')) {
      return Response.json({
        issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
        jwks_uri: issuer + '/jwks', response_types_supported: ['code'],
        id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/jwks') return Response.json({ keys: [jwk] });
    assert.equal(url.pathname, '/token');
    const params = new URLSearchParams(options.body);
    assert.equal(params.get('code'), 'fixture-code');
    assert.equal(params.get('redirect_uri'), origin + '/auth/oidc/dev/callback');
    const challenge = createHash('sha256').update(params.get('code_verifier')).digest('base64url');
    assert.equal(challenge, redirect.searchParams.get('code_challenge'));
    const now = Math.floor(Date.now() / 1000);
    const jwt = encode({ alg: 'RS256', kid: 'test' }) + '.' + encode({
      iss: issuer, sub: 'linked-subject', aud: values.DEV_OIDC_CLIENT_ID,
      iat: now, exp: now + 60, nonce: redirect.searchParams.get('nonce'), role: 'SUPER_ADMIN',
    });
    const signature = sign('RSA-SHA256', Buffer.from(corrupt ? jwt + 'corrupt' : jwt), privateKey);
    return Response.json({ access_token: 'fixture-access', token_type: 'Bearer',
      id_token: jwt + '.' + signature.toString('base64url') });
  });
  const redisStore = new Map();
  const account = { id: 'known-user', role: 'RIDER' };
  const handlers = oidcHandlers({
    redis: {
      set: async (key, value) => redisStore.set(key, value),
      get: async key => redisStore.get(key),
      getDel: async key => { const value = redisStore.get(key); redisStore.delete(key); return value; },
    },
    db: { query: async (_, parameters) => {
      assert.deepEqual(parameters, [issuer, 'linked-subject']);
      return { rows: [account] };
    } },
    failure: (status, message) => Object.assign(new Error(message), { status }),
    cookie: req => req.browser,
    matched: (left, right) => left === right,
    createSession: async (row, client) => ({ role: row.role, client }),
    randomToken: () => randomBytes(32).toString('base64url'),
    sha: value => createHash('sha256').update(value).digest('hex'),
  });
  const callback = () => handlers.callback('dev', {
    browser, query: { state: redirect.searchParams.get('state'), code: 'fixture-code' },
  }, res);
  await handlers.start('dev', res);
  assert.deepEqual(await callback(), { role: 'RIDER', client: 'web' });
  await assert.rejects(callback, { status: 401 });

  corrupt = true;
  await handlers.start('dev', res);
  await assert.rejects(callback, { status: 401 });
});
