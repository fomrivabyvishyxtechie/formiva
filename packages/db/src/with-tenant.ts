import { Pool, PoolClient } from 'pg';

export async function withTenant<T>(
  pool: Pool,
  workspaceId: string | null,
  userId: string | null,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Set transaction-local context; workspace-only context is used during membership resolution.
    if (workspaceId && userId) {
      await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', workspaceId]);
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
    } else if (workspaceId) {
      await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', workspaceId]);
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', '']);
    } else {
      await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', '']);
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', '']);
    }

    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
