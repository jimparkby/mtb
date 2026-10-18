// Тестовые базы: SQLite в памяти и настоящий Postgres (PGlite) через драйвер pg
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { openDatabase } from '../server/database.js';

export const DIALECTS = ['sqlite', 'postgres'];

export async function openTestDb(dialect) {
  if (dialect === 'sqlite') {
    const db = await openDatabase(':memory:');
    return { db, close: () => db.close() };
  }
  const pglite = await PGlite.create();
  const server = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
  await server.start();
  // PGlite обслуживает одно соединение
  const db = await openDatabase(`postgres://postgres@${server.getServerConn()}/postgres`, { max: 1 });
  return { db, close: async () => { await db.close(); await server.stop(); await pglite.close(); } };
}

export async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { base, call };
}
