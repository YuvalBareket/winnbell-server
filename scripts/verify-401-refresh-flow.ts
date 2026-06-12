/**
 * Diagnostic: simulates the client interceptor's 401→refresh→retry sequence
 * against the running dev server using the maya test persona.
 * Run from server/:  npx tsx scripts/verify-401-refresh-flow.ts
 */
import 'dotenv/config';
import jwt from 'jsonwebtoken';

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000';

const main = async () => {
  // 1. Ensure persona exists
  const setup = await fetch(`${BASE}/auth/test-setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona: 'maya' }),
  });
  if (!setup.ok) throw new Error(`test-setup failed: ${setup.status}`);
  const { user } = await setup.json() as { user: { id: number } };

  // 2. Login for a real refresh token
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'e2e.maya@e2e.winnbell.com', password: 'Wbll-E2E#9xTq2026!' }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const { refreshToken } = await login.json() as { refreshToken: string };

  // 3. Forge an EXPIRED internal JWT (same secret, exp in the past)
  const expired = jwt.sign(
    { id: user.id, role: 'User', location_id: null },
    process.env.JWT_SECRET as string,
    { expiresIn: '-1h' },
  );

  // 4. Request with expired token → must 401
  const r1 = await fetch(`${BASE}/tickets/my-risk-level`, { headers: { Authorization: `Bearer ${expired}` } });
  console.log('expired token request:', r1.status, r1.status === 401 ? '(401 as expected)' : '(UNEXPECTED)');

  // 5. Refresh → new token pair
  const r2 = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  console.log('refresh:', r2.status);
  const { token: newToken } = await r2.json() as { token: string };

  // 6. Retry with the fresh token → must succeed
  const r3 = await fetch(`${BASE}/tickets/my-risk-level`, { headers: { Authorization: `Bearer ${newToken}` } });
  console.log('retried request with refreshed token:', r3.status, r3.ok ? '(SUCCESS)' : '(FAILED)');
};

main().catch((e) => { console.error(e.message); process.exit(1); });
