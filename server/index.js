import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const db = openDb(process.env.DB_PATH || 'data/kopi.db');

createApp(db).listen(port, () => {
  console.log(`KOPI запущен: http://localhost:${port}`);
});
