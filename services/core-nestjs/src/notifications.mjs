import CircuitBreaker from 'opossum';
import amqp from 'amqplib';

export function startNotifications(db) {
  const direct = process.env.NOTIFICATIONS_URL;
  const broker = process.env.RABBITMQ_URL;
  const token = process.env.NOTIFICATIONS_TOKEN;
  if (!direct || !broker || !token) return () => {};
  const queue = 'motosys.notifications';
  const breaker = new CircuitBreaker(async event => {
    const response = await fetch(direct, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', authorization: 'Bearer ' + token,
        'idempotency-key': event.id,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(2000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error('Notificador indisponible.');
  }, { timeout: 2500, resetTimeout: 10000, volumeThreshold: 2, errorThresholdPercentage: 50 });
  breaker.fallback(async event => {
    const connection = await amqp.connect(broker, { timeout: 2000 });
    connection.on('error', () => {});
    // Abort the transport if the broker blocks confirmations under a resource alarm.
    const deadline = setTimeout(() => connection.connection.stream.destroy(), 5000);
    try {
      const channel = await connection.createConfirmChannel();
      await channel.assertQueue(queue, { durable: true });
      channel.sendToQueue(queue, Buffer.from(JSON.stringify(event)), {
        persistent: true, contentType: 'application/json', messageId: event.id,
      });
      await channel.waitForConfirms();
      await channel.close();
    } finally {
      await connection.close().catch(() => {});
      clearTimeout(deadline);
    }
  });

  let job;
  async function dispatch() {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows: [event] } = await client.query(
        `SELECT e.id, e.kind, e.motorcycle_id, e.actor_id
         FROM notification_outbox o JOIN vehicle_events e ON e.id=o.event_id
         WHERE o.delivered_at IS NULL ORDER BY o.queued_at LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
      );
      if (event) {
        await breaker.fire(event);
        await client.query('UPDATE notification_outbox SET delivered_at=now() WHERE event_id=$1', [event.id]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  const timer = setInterval(() => {
    if (job) return;
    job = dispatch().catch(() => process.stderr.write('Notificación pendiente de reintento.\n'))
      .finally(() => { job = undefined; });
  }, 2000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await job;
    breaker.shutdown();
  };
}
