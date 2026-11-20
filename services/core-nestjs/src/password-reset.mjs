import nodemailer from 'nodemailer';
import { z } from 'zod';

export const resetRequest = z.strictObject({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) });
export const resetConfirm = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: z.string().min(1).max(512) });

export function passwordResetHandlers({ db, redis, policy, hashPassword, randomToken, sha, validate, failure, throttle }, createTransport = nodemailer.createTransport) {
  const { SMTP_URL, RESET_PUBLIC_URL, RESET_FROM } = process.env;
  const smtp = SMTP_URL && RESET_PUBLIC_URL && RESET_FROM ? new URL(SMTP_URL) : null;
  if (smtp && !['smtp:', 'smtps:'].includes(smtp.protocol)) throw new Error('SMTP_URL inválida.');
  const secure = smtp?.protocol === 'smtps:';
  const transport = smtp ? createTransport({
    host: smtp.hostname, port: Number(smtp.port || (secure ? 465 : 587)), secure,
    requireTLS: !secure,
    ...(smtp.username ? { auth: {
      user: decodeURIComponent(smtp.username), pass: decodeURIComponent(smtp.password),
    } } : {}),
    connectionTimeout: 4000, greetingTimeout: 4000, socketTimeout: 6000,
  }) : null;
  const recoveryUrl = transport ? new URL(RESET_PUBLIC_URL) : null;
  if (recoveryUrl && recoveryUrl.protocol !== 'https:') throw new Error('RESET_PUBLIC_URL requiere HTTPS.');
  let mailInFlight = 0;

  return {
    async request(body, req, res) {
      if (!transport) throw failure(503, 'Recuperación de cuenta no configurada.');
      await throttle('reset-ip', req.ip, 10);
      const { email } = validate(resetRequest, body);
      await throttle('reset-email', email, 3);
      const { rows: [row] } = await db.query('SELECT id, session_version FROM users WHERE email=$1 AND password_hash IS NOT NULL', [email]);
      if (row && mailInFlight < 8) {
        const token = randomToken();
        const key = 'password-reset:' + sha(token);
        mailInFlight++;
        try {
          await redis.set(key, JSON.stringify({ id: row.id, version: row.session_version }), { EX: 900 });
        } catch (error) {
          mailInFlight--;
          throw error;
        }
        const link = new URL(recoveryUrl);
        link.hash = new URLSearchParams({ token }).toString();
        void transport.sendMail({ from: RESET_FROM, to: email, subject: 'Recuperar acceso a MotoSys',
          text: 'Abre este enlace en los próximos 15 minutos:\n' + link.href })
          .catch(async () => {
            await redis.del(key).catch(() => {});
            process.stderr.write('No se pudo enviar la recuperación.\n');
          }).finally(() => { mailInFlight--; });
      }
      res.status(202);
      return { accepted: true };
    },

    async confirm(body, req) {
      await throttle('reset-confirm', req.ip, 12);
      const input = validate(resetConfirm, body);
      let password;
      try {
        password = policy.validate(input.password, false);
      } catch (error) {
        throw failure(400, error.message);
      }
      const key = 'password-reset:' + sha(input.token);
      if (!await redis.exists(key)) throw failure(400, 'Recuperación caducada o inválida.');
      const hash = await hashPassword(password);
      const saved = JSON.parse(await redis.getDel(key) ?? 'null');
      if (!saved) throw failure(400, 'Recuperación caducada o inválida.');
      const result = await db.query(`UPDATE users SET password_hash=$1, session_version=session_version+1
        WHERE id=$2 AND session_version=$3 AND password_hash IS NOT NULL`, [hash, saved.id, saved.version]);
      if (!result.rowCount) throw failure(400, 'Recuperación caducada o inválida.');
      return { changed: true };
    },
  };
}
