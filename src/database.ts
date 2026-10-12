import { Pool } from 'pg'

export type Bindings = {
  DATABASE_URL?: string
  HYPERDRIVE?: { connectionString: string }
}

export function createPool(env: Bindings): Pool {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL または HYPERDRIVE が設定されていません。')
  }

  return new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000
  })
}
