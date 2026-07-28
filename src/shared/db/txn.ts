import type { PoolClient } from 'pg';

// Roll back a transaction WITHOUT masking the original error (P3-7). If the connection died
// mid-transaction (e.g. Neon 57P01), a bare `client.query('ROLLBACK')` in a catch block THROWS
// and that new error replaces the real one. Swallowing the rollback failure lets the caller
// re-throw the actual error; the pool discards the dead connection on release either way. Use as:
//   } catch (err) { await safeRollback(client); throw err; }
//
// Deliberately in its OWN module (not db.ts): the unit tests jest.mock the db module, which would
// turn safeRollback into `undefined`. Keeping it here (unmocked) means those tests run the REAL
// rollback against their mock client, so `ROLLBACK`-was-called assertions still hold.
export const safeRollback = async (client: PoolClient): Promise<void> => {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* connection already gone; the caller's original error stands */
  }
};
