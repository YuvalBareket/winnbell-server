/**
 * Live smoke test of recently changed paths against the running dev server.
 * Run from server/:  npx tsx scripts/smoke-test.ts
 */
import 'dotenv/config';

const BASE = 'http://localhost:3000';
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = '') => results.push([name, ok, detail]);

const main = async () => {
  // Personas
  const setup = async (persona: string) => {
    const r = await fetch(`${BASE}/auth/test-setup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona }),
    });
    return (await r.json()) as { token: string; user: { id: number } };
  };
  const maya = await setup('maya');
  const david = await setup('david');
  const authed = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

  // 1. Public nearby (business.service regression)
  const nearby = await fetch(`${BASE}/business/nearby?minLat=31&maxLat=33&minLng=34&maxLng=35.5`);
  check('public /business/nearby', nearby.status === 200, `status ${nearby.status}`);

  // 2. User tickets list (new promo-aware query)
  const tickets = await fetch(`${BASE}/tickets/my-tickets?draw_id=1`, { headers: authed(maya.token) });
  const tBody = await tickets.json() as { tickets?: unknown[]; totalCount?: number };
  check('user /tickets/my-tickets', tickets.status === 200 && Array.isArray(tBody.tickets), `status ${tickets.status}, count ${tBody.totalCount}`);

  // 3. Risk level (promo-aware count)
  const risk = await fetch(`${BASE}/tickets/my-risk-level`, { headers: authed(maya.token) });
  check('user /tickets/my-risk-level', risk.status === 200, `status ${risk.status}`);

  // 4. Business generates code ticket (new cap-fallback SQL)
  const gen = await fetch(`${BASE}/tickets/generate`, { method: 'POST', headers: authed(david.token), body: '{}' });
  const gBody = await gen.json() as { code?: string };
  check('business /tickets/generate', gen.status === 201 && !!gBody.code, `status ${gen.status}, code ${gBody.code ?? 'none'}`);

  // 5. Coordinate validation rejects bad lat/lon
  const badLoc = await fetch(`${BASE}/business/locations`, {
    method: 'POST', headers: authed(david.token),
    body: JSON.stringify({ name: 'X', address: 'Y', lat: 'abc', lon: 999 }),
  });
  check('addLocation rejects bad coords (400)', badLoc.status === 400, `status ${badLoc.status}`);

  // 6. Campaign settings rejects negative threshold
  const badAmt = await fetch(`${BASE}/business/campaign-settings`, {
    method: 'PATCH', headers: authed(david.token),
    body: JSON.stringify({ min_transaction_amount: -5 }),
  });
  check('campaign-settings rejects -5 (400)', badAmt.status === 400, `status ${badAmt.status}`);

  // 7. Campaign settings accepts valid threshold
  const goodAmt = await fetch(`${BASE}/business/campaign-settings`, {
    method: 'PATCH', headers: authed(david.token),
    body: JSON.stringify({ min_transaction_amount: 12.5 }),
  });
  check('campaign-settings accepts 12.5 (200)', goodAmt.status === 200, `status ${goodAmt.status}`);

  // 8. Upload URL with size; reject oversize
  const upOk = await fetch(`${BASE}/tickets/receipt-upload-url?size=204800`, { headers: authed(maya.token) });
  check('receipt upload-url with size (200)', upOk.status === 200, `status ${upOk.status}`);
  const upBad = await fetch(`${BASE}/tickets/receipt-upload-url?size=${20 * 1024 * 1024}`, { headers: authed(maya.token) });
  check('receipt upload-url oversize (400)', upBad.status === 400, `status ${upBad.status}`);

  // 9. Region check (public, current allowed_states=[])
  const region = await fetch(`${BASE}/auth/region-check`);
  const rBody = await region.json() as { blocked?: boolean };
  check('region-check unrestricted (blocked=false)', region.status === 200 && rBody.blocked === false, `status ${region.status}, blocked ${rBody.blocked}`);

  // 10. Draws public endpoints (cache typing change)
  const draws = await fetch(`${BASE}/draws/active`);
  const history = await fetch(`${BASE}/draws/history`);
  check('public /draws/active + /draws/history', draws.status === 200 && history.status === 200, `${draws.status}/${history.status}`);

  // Report
  let failed = 0;
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
    if (!ok) failed++;
  }
  console.log(failed === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(1); });
