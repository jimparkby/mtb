import { join } from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
// На Railway база лежит на подключённом volume, иначе пропадёт при каждом деплое.
const dbPath = process.env.DB_PATH
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH && join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'kopi.db'))
  || 'data/kopi.db';
const db = openDb(dbPath);
console.log(`База: ${dbPath}`);

createApp(db).listen(port, () => {
  console.log(`KOPI запущен: http://localhost:${port}`);
});
