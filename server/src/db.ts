// ── Postgres D1-shim: mimics Cloudflare D1 prepared-statement API on top of pg ──
// Lets worker/routes/*.ts keep using db.prepare(...).bind(...).first/all/run + db.batch(...)

import pg from 'pg';
import type { Pool as PoolType, PoolClient, PoolConfig } from 'pg';

const { Pool, types } = pg;

// Parse Postgres BIGINT (INT8, OID 20) as JS number so epoch timestamps
// and COUNT(*) values behave identically to Cloudflare D1 / SQLite.
types.setTypeParser(types.builtins.INT8, (val: string) => parseInt(val, 10));

// Convert `?` placeholders to $1, $2, ...
export function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export interface D1AllResult<T = any> {
  results: T[];
  success: boolean;
}

export interface D1RunResult {
  success: boolean;
  meta: { last_row_id?: number; changes?: number };
}

class PreparedStatement {
  constructor(
    private pool: PoolType,
    private client: PoolClient | null,
    private sql: string,
    private params: any[] = [],
  ) {}

  bind(...params: any[]): PreparedStatement {
    const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    return new PreparedStatement(this.pool, this.client, this.sql, flat);
  }

  private async exec(): Promise<{ rows: any[]; rowCount: number }> {
    const pgSql = toPg(this.sql);
    const runner = this.client ?? this.pool;
    // Auto-capture SERIAL id for message inserts (used for attachment linking)
    const isMessageInsert =
      /^\s*INSERT\s+INTO\s+messages\b/i.test(this.sql) && !/RETURNING/i.test(this.sql);
    const finalSql = isMessageInsert ? `${pgSql} RETURNING id` : pgSql;
    const res = await (runner as any).query(finalSql, this.params);
    return { rows: res.rows ?? [], rowCount: res.rowCount ?? 0 };
  }

  async first<T = any>(): Promise<T | null> {
    const { rows } = await this.exec();
    return (rows[0] as T) ?? null;
  }

  async all<T = any>(): Promise<D1AllResult<T>> {
    const { rows } = await this.exec();
    return { results: rows as T[], success: true };
  }

  async run(): Promise<D1RunResult> {
    const { rows, rowCount } = await this.exec();
    const lastId = rows[0]?.id;
    return {
      success: true,
      meta: {
        ...(lastId !== undefined ? { last_row_id: Number(lastId) } : {}),
        changes: rowCount,
      },
    };
  }

  get _sql() {
    return this.sql;
  }
  get _params() {
    return this.params;
  }
}

export class PgD1Db {
  constructor(private pool: PoolType) {}

  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(this.pool, null, sql);
  }

  async batch(statements: PreparedStatement[]): Promise<D1RunResult[]> {
    const client = await this.pool.connect();
    const out: D1RunResult[] = [];
    try {
      await client.query('BEGIN');
      for (const st of statements) {
        const sql = st._sql ?? '';
        const params = st._params ?? [];
        const pgSql = toPg(sql);
        const isMessageInsert =
          /^\s*INSERT\s+INTO\s+messages\b/i.test(sql) && !/RETURNING/i.test(sql);
        const finalSql = isMessageInsert ? `${pgSql} RETURNING id` : pgSql;
        const res = await client.query(finalSql, params);
        const lastId = (res.rows[0] as any)?.id;
        out.push({
          success: true,
          meta: {
            ...(lastId !== undefined ? { last_row_id: Number(lastId) } : {}),
            changes: res.rowCount ?? 0,
          },
        });
      }
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}

export interface PgConnectionSummary {
  mode: 'database-url' | 'cloudsql-socket' | 'tcp-host';
  target: string;
  ssl: boolean;
}

function summarizeDatabaseUrl(connectionString: string): string {
  try {
    const u = new URL(connectionString);
    const dbName = u.pathname.replace(/^\//, '') || '(default)';
    const socketHost = u.searchParams.get('host');
    if (socketHost) {
      return `${socketHost}/${dbName}`;
    }
    const hostPort = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    return `${hostPort}/${dbName}`;
  } catch {
    return '(configured via DATABASE_URL)';
  }
}

export function buildPgPoolConfig(
  env: NodeJS.ProcessEnv = process.env,
): { config: PoolConfig; summary: PgConnectionSummary } {
  const maxRaw = Number(env.DB_POOL_MAX || 10);
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 10;
  const baseDefaults: Pick<PoolConfig, 'max' | 'idleTimeoutMillis' | 'connectionTimeoutMillis'> = {
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };

  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) {
    const isUnixSocketUrl =
      databaseUrl.includes('/cloudsql/') || databaseUrl.includes('/var/run/');
    const useSsl = env.DB_SSL === 'true' && !isUnixSocketUrl;
    const config: PoolConfig = {
      ...baseDefaults,
      connectionString: databaseUrl,
      ...(useSsl
        ? { ssl: { rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } }
        : {}),
    };
    return {
      config,
      summary: {
        mode: 'database-url',
        target: summarizeDatabaseUrl(databaseUrl),
        ssl: useSsl,
      },
    };
  }

  const instanceConnectionName = (
    env.INSTANCE_CONNECTION_NAME || env.CLOUD_SQL_CONNECTION_NAME
  )?.trim();
  if (instanceConnectionName) {
    const socketDir = (env.CLOUD_SQL_SOCKET_DIR || '/cloudsql').replace(/\/+$/, '');
    const host = `${socketDir}/${instanceConnectionName}`;
    const user = env.DB_USER || 'postgres';
    const database = env.DB_NAME || 'gtm_chat_history';
    return {
      config: {
        ...baseDefaults,
        host,
        user,
        password: env.DB_PASSWORD,
        database,
      },
      summary: {
        mode: 'cloudsql-socket',
        target: `${host}/${database}`,
        ssl: false,
      },
    };
  }

  const tcpHost = env.DB_HOST?.trim();
  if (tcpHost) {
    const portRaw = Number(env.DB_PORT || 5432);
    const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 5432;
    const user = env.DB_USER || 'postgres';
    const database = env.DB_NAME || 'gtm_chat_history';
    const useSsl = env.DB_SSL === 'true';
    return {
      config: {
        ...baseDefaults,
        host: tcpHost,
        port,
        user,
        password: env.DB_PASSWORD,
        database,
        ...(useSsl
          ? { ssl: { rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } }
          : {}),
      },
      summary: {
        mode: 'tcp-host',
        target: `${tcpHost}:${port}/${database}`,
        ssl: useSsl,
      },
    };
  }

  throw new Error(
    'Missing Postgres configuration: set DATABASE_URL, INSTANCE_CONNECTION_NAME (+ DB_USER/DB_PASSWORD/DB_NAME), or DB_HOST (+ DB_USER/DB_PASSWORD/DB_NAME)',
  );
}

let pool: PoolType | null = null;

export function getPool(): PoolType {
  if (pool) return pool;
  const { config } = buildPgPoolConfig();
  pool = new Pool(config);
  pool.on('error', (e) => console.error('[pg] pool error', e));
  return pool;
}

export function getDb(): PgD1Db {
  return new PgD1Db(getPool());
}

export async function checkDbHealth(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    await getPool().query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err?.message ?? 'Database health check failed',
    };
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
