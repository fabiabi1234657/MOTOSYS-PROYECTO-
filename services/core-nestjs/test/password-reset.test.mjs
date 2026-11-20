import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { passwordResetHandlers } from '../src/password-reset.mjs';

test('recuperación responde de forma genérica y guarda solo el hash durante 15 minutos', async t => {
  for (const [key, value] of Object.entries({
    SMTP_URL: 'smtp://mail.example.invalid', RESET_PUBLIC_URL: 'https://motosys.example.invalid/reset',
    RESET_FROM: 'no-reply@example.invalid',
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const token = 'a'.repeat(43);
  const sha = value => createHash('sha256').update(value).digest('hex');
  const mail = [];
  const saved = [];
  const limits = [];
  const cases = [];
  const handlers = passwordResetHandlers({
    db: { query: async (_, [email]) => ({ rows: email === 'known@example.invalid'
      ? [{ id: 'fixture-id', session_version: 2 }] : [] }) },
    redis: { set: async (...args) => saved.push(args) },
    validate: (schema, body) => schema.parse(body),
    throttle: async (...args) => limits.push(args), randomToken: () => token, sha,
  }, () => ({ sendMail: async message => mail.push(message) }));
  const response = { status: code => cases.push(code) };
  for (const email of ['known@example.invalid', 'unknown@example.invalid']) {
    assert.deepEqual(await handlers.request({ email }, { ip: '127.0.0.1' }, response), { accepted: true });
  }
  assert.deepEqual(cases, [202, 202]);
  assert.deepEqual(saved, [['password-reset:' + sha(token), '{"id":"fixture-id","version":2}', { EX: 900 }]]);
  assert.equal(limits.length, 4);
  assert.equal(mail.length, 1);
  assert.match(mail[0].text, /https:\/\/motosys\.example\.invalid\/reset#token=/);
});
