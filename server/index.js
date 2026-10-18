import { join } from 'node:path';
import { openDatabase } from './database.js';
import { createApp } from './app.js';
import { createRates } from './rates.js';
import { brokerFromEnv } from './broker.js';

const env = process.env;
const port = Number(env.PORT) || 3000;
// PostgreSQL, если задан DATABASE_URL (Railway Postgres). Иначе SQLite: на Railway —
// на подключённом volume, иначе база пропадёт при каждом деплое.
const target = env.DATABASE_URL
  || env.DB_PATH
  || (env.RAILWAY_VOLUME_MOUNT_PATH && join(env.RAILWAY_VOLUME_MOUNT_PATH, 'kopi.db'))
  || 'data/kopi.db';
const db = await openDatabase(target, { ssl: env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });
console.log(`База: ${db.dialect}${db.dialect === 'sqlite' ? ' ' + target : ''}`);

const rates = await createRates(db);
await rates.start(); // первый курс до создания демо-данных, чтобы они считались от реального курса

const broker = brokerFromEnv(env);
const app = await createApp(db, { rates, broker });
console.log(`Брокер: ${broker.name}`);

// Сверка покупок: докупить списанное, пометить зависшее
setInterval(() => app.purchaser.reconcile().catch((err) => console.error('[reconcile]', err)), 60_000).unref();
// Сессия гостя живёт неделю; после неё гость и его данные удаляются
setInterval(() => app.cleanupGuests().catch((err) => console.error('[guests]', err)), 60 * 60_000).unref();

app.listen(port, () => {
  console.log(`KOPI запущен: http://localhost:${port}`);
});
