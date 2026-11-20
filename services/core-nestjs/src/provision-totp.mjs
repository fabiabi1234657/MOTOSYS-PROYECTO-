import pg from 'pg';
import { authenticator } from 'otplib';
import { encryptTotpSecret } from './totp-secret.mjs';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !process.env.DATABASE_URL) throw new Error('Configura DATABASE_URL y proporciona el correo.');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const { rows: [row] } = await db.query('SELECT id FROM users WHERE email=$1 AND totp_secret IS NULL', [email]);
  if (!row) throw new Error('Cuenta inexistente o TOTP ya configurado.');
  const secret = authenticator.generateSecret(20);
  const result = await db.query(
    'UPDATE users SET totp_secret=$1 WHERE id=$2 AND totp_secret IS NULL',
    [encryptTotpSecret(secret, row.id), row.id],
  );
  if (result.rowCount !== 1) throw new Error('Otra operación configuró TOTP.');
  process.stdout.write(authenticator.keyuri(email, 'MotoSys', secret) + '\n');
} finally {
  await db.end();
}
