#!/usr/bin/env node
/**
 * The X add-on against MODEL V6, end to end on real Stripe test-mode objects.
 * Every scenario runs on its own tenant bound to a Stripe test clock set to the
 * dates the model's own worked examples use, so the expected numbers are the
 * model's numbers (1,066 / 1,733 / 580 + 1,420 …), not ones derived here.
 *
 *   node scripts/verify-x-v6.mjs [--keep] [--only=A,D]
 *
 * The backend must be running. Run it alone: it switches the shared billing
 * policy and tightens the capacity ceiling while it runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL ?? 'http://localhost:3123/api';
const KEEP = process.argv.includes('--keep');
const ONLY = (process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? '').split(',').filter(Boolean);
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../backend/package.json'));
const Stripe = require('stripe');
const env = fs.readFileSync(path.join(here, '../backend/.env'), 'utf8');
const stripe = new Stripe(env.match(/^STRIPE_SECRET_KEY=(.*)$/m)[1].trim());

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  head: (s) => `\x1b[1m\x1b[36m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
};
let failures = 0;
let passes = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    passes += 1;
    console.log(`  ${c.ok('✓')} ${label} ${c.dim(detail)}`);
  } else {
    failures += 1;
    console.log(`  ${c.bad('✗')} ${label} ${c.warn(detail)}`);
  }
};
const near = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance;
const money = (cents) => `$${((cents ?? 0) / 100).toFixed(2)}`;
const day = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : '—');
const at = (y, m, d, h = 0) => Date.UTC(y, m - 1, d, h) / 1000;

const call = async (method, p, body) => {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = json?.message?.message ?? json?.message ?? res.statusText;
    const err = new Error(`${method} ${p} → ${res.status}: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
    err.status = res.status;
    throw err;
  }
  return json;
};
const GET = (p) => call('GET', p);
const POST = (p, b) => call('POST', p, b);
const PUT = (p, b) => call('PUT', p, b);
const DELETE = (p) => call('DELETE', p);
const refused = async (fn, pattern) => {
  try {
    await fn();
    return { refused: false, message: 'accepted' };
  } catch (err) {
    return { refused: pattern ? pattern.test(err.message) : true, message: err.message, status: err.status };
  }
};

const X = [{ code: 'x_social', quantity: 1 }];
const created = [];

async function tenant(label, clockStart, { term = 'monthly', card = 'visa', plan = 'standard', screens = 1 } = {}) {
  const account = await POST('/accounts', {
    email: `x-v6-${label}-${Date.now()}@optisigns-billing-demo.test`,
    name: `X V6 ${label}`,
    withTestClock: true,
    clockStart,
  });
  created.push(account._id);
  if (card) await POST(`/accounts/${account._id}/payment-method/test`, { kind: card });
  const base = { planCode: plan, term, screens, addOns: [] };
  if (card) await POST(`/subscriptions/${account._id}/change`, base);
  return { id: account._id, base };
}
const state = (id) => GET(`/subscriptions/${id}`);
const advance = (id, to) => POST(`/simulator/${id}/advance`, { to });
const buyX = (t, extra = {}) => POST(`/subscriptions/${t.id}/change`, { ...t.base, ...extra, addOns: X });
const sync = (id, body) => POST(`/x-addon/${id}/sync-runs`, body);
const invoices = (id) => GET(`/billing/accounts/${id}/invoices`);
const balance = async (id) => (await GET(`/accounts/${id}/balance`)).balance;
const hasXItem = (s) => (s.current.addOns ?? []).some((a) => a.code === 'x_social');

async function scenario(key, title, fn) {
  if (ONLY.length && !ONLY.includes(key)) return;
  console.log(`\n${c.head(`${key} · ${title}`)}`);
  try {
    await fn();
  } catch (err) {
    failures += 1;
    console.log(`  ${c.bad('✗')} scenario aborted: ${c.warn(err.message)}`);
  }
}

const run = async () => {
  console.log(c.head('0 · Environment'));
  const catalog = await GET('/catalog');
  check('Stripe key configured', catalog.stripeConfigured);
  await POST('/catalog/sync-stripe');
  const x = (await GET('/catalog')).addons.find((a) => a.code === 'x_social');
  check('One X add-on, quantity fixed at 1', Boolean(x) && x.maxQuantity === 1, x ? `${x.code} max ${x.maxQuantity}` : 'missing');
  check('$20 a month, $216 a year (row 4)', x?.monthlyCents === 2000 && x?.annualMonthlyCents * 12 === 21600,
    `${money(x?.monthlyCents)} / ${money(x?.annualMonthlyCents * 12)}`);
  check('No Standard/Pro tiers left (row 48)', !(await GET('/catalog')).addons.some((a) => /x_social_(standard|pro)/.test(a.code)));
  await POST('/policy/presets/scio_portal_mvp');

  await scenario('A', 'First purchase mid quota month, deduction by billed Posts, reset at the quota boundary', async () => {
    const t = await tenant('a', at(2026, 9, 1));
    await advance(t.id, at(2026, 9, 15));

    const mixed = await refused(() => POST(`/subscriptions/${t.id}/change`, { ...t.base, screens: 2, addOns: X }), /on its own/);
    check('X is not bought inside an unrelated change', mixed.refused, mixed.message.slice(-90));
    const two = await refused(() => POST(`/subscriptions/${t.id}/change`, { ...t.base, addOns: [{ code: 'x_social', quantity: 2 }] }), /quantity fixed at 1/);
    check('Quantity 2 is refused at the API (EASY 5)', two.refused, two.message.slice(-80));

    const preview = await POST(`/subscriptions/${t.id}/preview`, { ...t.base, addOns: X });
    check('Preview opens floor(2,000 × 16/30) = 1,066 (CASE 1)', preview.mode === 'x_purchase' && preview.quota?.delta === 1066,
      `${preview.mode} · ${preview.quota?.formula}`);
    check('Preview asks Stripe for the prorated charge now', preview.invoice && near(preview.invoice.amountDue, 1067),
      money(preview.invoice?.amountDue));

    const bought = await buyX(t);
    const s = bought.state.xAddon;
    check('ACTIVE after the invoice is paid', s.status === 'ACTIVE' && s.canFetchNewPosts, s.status);
    check('Granted 1,066 for the quota month 01/09 → 01/10', s.ledger?.granted === 1066 && s.quotaMonth.start === at(2026, 9, 1),
      `${s.ledger?.granted} · ${day(s.quotaMonth.start)} → ${day(s.quotaMonth.end)}`);
    const inv = (await invoices(t.id))[0];
    check('Stripe charged $20 × 16/30 for the rest of the billing period', inv.status === 'paid' && near(inv.total, 1067),
      `${inv.number} ${money(inv.total)}`);
    check('Capacity reservation committed', s.capacity.mine?.status === 'committed', JSON.stringify(s.capacity.mine));
    check('One Stripe item, quantity 1', bought.state.stripe.items.filter((i) => i.quantity === 1).length === 2);

    const r1 = await sync(t.id, { kind: 'auto', requested: 50, returned: 12, actionId: 'a-1' });
    check('Request 50, X returns 12 → −12 (row 12)', r1.run.charged === 12 && r1.run.remaining === 1054, JSON.stringify(r1.run));
    const r1b = await sync(t.id, { kind: 'auto', requested: 50, returned: 12, actionId: 'a-1' });
    check('The same actionId twice deducts once', r1b.run.duplicate === true && r1b.state.xAddon.ledger.used === 12,
      `used ${r1b.state.xAddon.ledger.used}`);
    const r0 = await sync(t.id, { kind: 'initial', requested: 50, returned: 0, actionId: 'a-0' });
    check('X returns 0 Posts → −0 (EASY 2)', r0.run.charged === 0, JSON.stringify(r0.run));
    const r2 = await sync(t.id, { kind: 'manual', requested: 5000, returned: 5000, actionId: 'a-2' });
    check('A deduction is clamped by QuotaRemaining', r2.run.charged === 1054 && r2.run.clamped && r2.run.remaining === 0,
      JSON.stringify(r2.run));
    check('100% warning, no overage', r2.state.xAddon.warnings.some((w) => /100%/.test(w)) && !r2.state.xAddon.canFetchNewPosts);
    const r3 = await refused(() => sync(t.id, { kind: 'manual', returned: 1 }), /exhausted/);
    check('At 0 remaining the fetch is not attempted (row 11)', r3.refused && r3.status === 409, r3.message.slice(-70));

    const oct = await advance(t.id, at(2026, 10, 1, 1));
    const so = oct.state.xAddon;
    check('New quota month on 01/10 with the renewal paid: 2,000', so.ledger?.granted === 2000 && so.quotaMonth.start === at(2026, 10, 1),
      `${so.ledger?.granted} · ${day(so.quotaMonth.start)}`);
    check('Used starts at 0 — September\'s leftover does not roll over', so.ledger?.used === 0, `used ${so.ledger?.used}`);
    t.done = true;
  });

  await scenario('B', 'Billing anchor ≠ quota month: delta on renewal, payment failure, paid retry', async () => {
    const t = await tenant('b', at(2026, 9, 10));
    const bought = await buyX(t);
    check('Bought on 10/09: floor(2,000 × 21/30) = 1,400', bought.state.xAddon.ledger?.granted === 1400, `${bought.state.xAddon.ledger?.granted}`);

    const early = (await advance(t.id, at(2026, 10, 2))).state.xAddon;
    check('October before the renewal: floor(2,000 × 9/31) = 580 (row 46)', early.ledger?.granted === 580, `${early.ledger?.granted}`);
    check('UI says the month is granted by paid time, not lost (row 56)',
      early.warnings.some((w) => /Paid through 2026-10-10/.test(w) && /not lost/.test(w)), early.warnings[0]);
    await sync(t.id, { kind: 'auto', returned: 100, actionId: 'b-1' });

    const renewed = (await advance(t.id, at(2026, 10, 10, 1))).state.xAddon;
    check('Renewal paid on 10/10 adds the missing +1,420 to the same ledger (row 66)', renewed.ledger?.granted === 2000,
      `${renewed.ledger?.granted} · grants ${renewed.ledger?.grants.map((g) => `+${g.delta}`).join(' ')}`);
    check('Used is untouched by the renewal', renewed.ledger?.used === 100, `used ${renewed.ledger?.used}`);

    await POST(`/accounts/${t.id}/payment-method/test`, { kind: 'charge_fails' });
    const failed = (await advance(t.id, at(2026, 11, 10, 1))).state;
    const xs = failed.xAddon;
    check('Renewal 10/11 fails: Stripe keeps it open', failed.stripe.status === 'past_due', failed.stripe.status);
    check('November grants only the paid 01/11 → 10/11: 600 (row 53)', xs.ledger?.granted === 600, `${xs.ledger?.granted}`);
    check('Past paidThrough nothing is fetched (PAYMENT_PENDING)', xs.status === 'PAYMENT_PENDING' && !xs.canFetchNewPosts, xs.status);
    const blocked = await refused(() => sync(t.id, { kind: 'auto', returned: 5 }), /PAYMENT_PENDING/);
    check('A sync run is refused, nothing charged', blocked.refused && blocked.status === 409);

    await POST(`/accounts/${t.id}/payment-method/test`, { kind: 'visa' });
    const open = (await invoices(t.id)).find((i) => i.status === 'open');
    await POST(`/billing/invoices/${open.id}/pay`);
    const paid = (await state(t.id)).xAddon;
    check('Paid on retry: ACTIVE, +1,400 delta, Used kept (EASY 4)', paid.status === 'ACTIVE' && paid.ledger?.granted === 2000 && paid.ledger?.used === 0,
      `${paid.status} · ${paid.ledger?.granted} / used ${paid.ledger?.used}`);
    t.done = true;
  });

  await scenario('C', 'Monthly cancel → resume in the same quota month; resume after it is a new activation', async () => {
    const t = await tenant('c', at(2026, 9, 1));
    await buyX(t);
    await sync(t.id, { kind: 'initial', returned: 300, actionId: 'c-1' });
    await advance(t.id, at(2026, 9, 10));

    const before = await balance(t.id);
    const invCount = (await invoices(t.id)).length;
    const pv = await POST(`/x-addon/${t.id}/preview/cancel`);
    check('Cancel preview: monthly is proration_behavior=none, no invoice', pv.stripeParams.proration_behavior === 'none' && !pv.invoice);
    const cancelled = (await POST(`/x-addon/${t.id}/cancel`)).state;
    const xs = cancelled.xAddon;
    check('Cancel takes effect now: X item gone, base untouched', !hasXItem(cancelled) && cancelled.stripe.status === 'active');
    check('FROZEN until quotaMonthEnd 01/10, fan-out off', xs.status === 'FROZEN' && xs.frozen?.until === at(2026, 10, 1) && !xs.fanOut && !xs.canFetchNewPosts,
      `${xs.status} until ${day(xs.frozen?.until)}`);
    check('Monthly: no refund (row 49)', (await balance(t.id)) === before && (await invoices(t.id)).length === invCount, money(before));
    check('Capacity released', xs.capacity.mine === null);
    const frozenRun = await refused(() => sync(t.id, { kind: 'manual', returned: 1 }), /FROZEN/);
    check('A frozen tenant fetches nothing', frozenRun.refused);

    await advance(t.id, at(2026, 9, 15));
    const rp = await POST(`/x-addon/${t.id}/preview/resume`);
    check('Resume preview: time already paid → proration none, nothing charged twice (EASY 1)',
      rp.stripeParams.proration_behavior === 'none' && !rp.invoice, rp.explanation[1]);
    const resumed = (await POST(`/x-addon/${t.id}/resume`)).state.xAddon;
    check('Resumed into the same ledger: Granted 2,000 / Used 300 (row 59)', resumed.status === 'ACTIVE' && resumed.ledger?.granted === 2000 && resumed.ledger?.used === 300,
      `${resumed.status} · ${resumed.ledger?.granted} / ${resumed.ledger?.used}`);
    check('No invoice for the resume', (await invoices(t.id)).length === invCount);
    check('Capacity reserved again', resumed.capacity.mine?.status === 'committed');

    await advance(t.id, at(2026, 9, 20));
    await POST(`/x-addon/${t.id}/cancel`);
    const later = (await advance(t.id, at(2026, 10, 5))).state.xAddon;
    check('After quotaMonthEnd it is CANCELED — the old quota expired', later.status === 'CANCELED' && later.resume?.kind === 'new_activation',
      `${later.status} · ${later.resume?.kind}`);
    const react = (await POST(`/x-addon/${t.id}/resume`)).state;
    const inv = (await invoices(t.id))[0];
    check('New activation charges from 05/10 to the 01/11 boundary', inv.status === 'paid' && near(inv.total, Math.round((2000 * 27) / 31)),
      `${inv.number} ${money(inv.total)}`);
    check('October granted by paid coverage: floor(2,000 × 27/31) = 1,741, Used 0', react.xAddon.ledger?.granted === 1741 && react.xAddon.ledger?.used === 0,
      `${react.xAddon.ledger?.granted} / ${react.xAddon.ledger?.used}`);
    t.done = true;
  });

  await scenario('D', 'Yearly: the model\'s own 05/09 example, cancel credit from quotaMonthEnd, resume debits it back', async () => {
    const t = await tenant('d', at(2026, 9, 5), { term: 'yearly' });
    const bought = await buyX(t);
    check('Annual bought 05/09: first quota month 05/09 → 01/10 = 1,733 (row 63)', bought.state.xAddon.ledger?.granted === 1733,
      `${bought.state.xAddon.ledger?.granted}`);
    const buyInv = (await invoices(t.id))[0];
    check('$216 charged for the year', buyInv.status === 'paid' && near(buyInv.total, 21600), money(buyInv.total));

    await advance(t.id, at(2026, 9, 20));
    const before = await balance(t.id);
    const pv = await POST(`/x-addon/${t.id}/preview/cancel`);
    check('Cancel preview: proration_date = quotaMonthEnd 01/10', pv.stripeParams.proration_date === at(2026, 10, 1), day(pv.stripeParams.proration_date));
    const cancelled = (await POST(`/x-addon/${t.id}/cancel`)).state;
    const credit = before - (await balance(t.id));
    const expected = Math.round((21600 * (at(2027, 9, 5) - at(2026, 10, 1))) / (at(2027, 9, 5) - at(2026, 9, 5)));
    check('Stripe credits 01/10/2026 → 05/09/2027 to the customer balance (row 7)', near(credit, expected, 2), `${money(credit)} ≈ ${money(expected)}`);
    check('September stays granted and FROZEN', cancelled.xAddon.status === 'FROZEN' && cancelled.xAddon.ledger?.granted === 1733);

    await advance(t.id, at(2026, 9, 25));
    const rp = await POST(`/x-addon/${t.id}/preview/resume`);
    check('Resume re-debits from the same boundary', rp.stripeParams.proration_date === at(2026, 10, 1) && rp.stripeParams.proration_behavior === 'always_invoice',
      `${day(rp.stripeParams.proration_date)} · ${rp.stripeParams.proration_behavior}`);
    const resumed = (await POST(`/x-addon/${t.id}/resume`)).state.xAddon;
    const inv = (await invoices(t.id))[0];
    check('The resume invoice equals the credit, paid from the balance', near(inv.total, credit, 2) && inv.amountDue === 0 && inv.status === 'paid',
      `${inv.number} ${money(inv.total)} due ${money(inv.amountDue)}`);
    check('Balance back where it was, no card charge', near(await balance(t.id), before, 2), money(await balance(t.id)));
    check('Same ledger: 1,733 granted, not granted again', resumed.status === 'ACTIVE' && resumed.ledger?.granted === 1733,
      `${resumed.status} · ${resumed.ledger?.granted}`);
    check('Coverage is one continuous year again', resumed.coverage.length === 1 && resumed.coverage[0].end === at(2027, 9, 5),
      JSON.stringify(resumed.coverage.map((i) => `${day(i.start)}→${day(i.end)}`)));
    t.done = true;
  });

  await scenario('E', 'Interval change: native proration with X active, X left out while frozen', async () => {
    const t = await tenant('e', at(2026, 9, 15));
    await buyX(t);
    await sync(t.id, { kind: 'auto', returned: 100, actionId: 'e-1' });
    await advance(t.id, at(2026, 9, 20));

    const yearly = await POST(`/subscriptions/${t.id}/change`, { ...t.base, term: 'yearly', addOns: X });
    const inv = (await invoices(t.id))[0];
    const xLines = inv.lines.filter((l) => /X Social/.test(l.description ?? ''));
    check('X moves to yearly with the base, prorated by Stripe (row 60)',
      yearly.state.current.term === 'yearly' && xLines.some((l) => l.amount < 0) && xLines.some((l) => l.amount > 0),
      xLines.map((l) => money(l.amount)).join(' '));
    const xs = yearly.state.xAddon;
    check('15/09 → 01/10 still 1,066 — the switch grants no second time (CASE 9)', xs.ledger?.granted === 1066, `${xs.ledger?.granted}`);
    check('Used 100 kept', xs.ledger?.used === 100);
    check('Paid coverage now runs to 20/09/2027', xs.coverage.at(-1)?.end === at(2027, 9, 20), day(xs.coverage.at(-1)?.end));

    await advance(t.id, at(2026, 9, 22));
    await POST(`/x-addon/${t.id}/cancel`);
    await advance(t.id, at(2026, 9, 23));
    const monthly = await POST(`/subscriptions/${t.id}/change`, { ...t.base, term: 'monthly', addOns: [] });
    const inv2 = (await invoices(t.id))[0];
    check('While frozen, only the base changes interval — no X line (row 64)',
      monthly.state.current.term === 'monthly' && !inv2.lines.some((l) => /X Social/.test(l.description ?? '')) && monthly.state.xAddon.status === 'FROZEN',
      `${monthly.state.xAddon.status}`);
    await advance(t.id, at(2026, 9, 24));
    const rp = await POST(`/x-addon/${t.id}/preview/resume`);
    check('Resume charges from where the yearly credit started (01/10), on the new monthly price',
      rp.stripeParams.proration_date === at(2026, 10, 1) && rp.stripeParams.items[0].price !== undefined,
      `${day(rp.stripeParams.proration_date)}`);
    const resumed = (await POST(`/x-addon/${t.id}/resume`)).state.xAddon;
    const inv3 = (await invoices(t.id))[0];
    const expected = Math.round((2000 * (at(2026, 10, 23) - at(2026, 10, 1))) / (at(2026, 10, 23) - at(2026, 9, 23)));
    check('Charged 01/10 → 23/10 at $20/month', near(inv3.total, expected, 2), `${money(inv3.total)} ≈ ${money(expected)}`);
    check('September ledger unchanged: 1,066 / 100', resumed.ledger?.granted === 1066 && resumed.ledger?.used === 100,
      `${resumed.ledger?.granted} / ${resumed.ledger?.used}`);
    t.done = true;
  });

  await scenario('F', 'Capacity admission: reserve before Stripe, refuse past the commercial ceiling', async () => {
    const t = await tenant('f', at(2026, 9, 1));
    const cap = (await GET(`/x-addon/${t.id}`)).capacity;
    check('Ceiling 2,500,000 of a 3,000,000 hard cap, 500,000 buffer (row 17)', cap.ceiling === 2500000 && cap.hardCap === 3000000 && cap.buffer === 500000);
    const used = cap.committed + cap.pending;
    await PUT('/policy', { constraints: { xCommercialCeilingUnits: used + 1999 } });
    const invBefore = (await invoices(t.id)).length;
    const full = await refused(() => buyX(t), /capacity is full/);
    check('One unit short of room for 2,000: refused', full.refused, full.message.slice(-110));
    const after = await state(t.id);
    check('Nothing was sent to Stripe', !hasXItem(after) && (await invoices(t.id)).length === invBefore && after.xAddon.capacity.mine === null);

    await PUT('/policy', { constraints: { xCommercialCeilingUnits: used + 2000 } });
    const ok = await buyX(t);
    check('Exactly at the ceiling is admitted (≤)', ok.state.xAddon.status === 'ACTIVE' && ok.state.xAddon.capacity.committed === used + 2000,
      `${ok.state.xAddon.capacity.committed}`);
    const yearly = await refused(() => POST(`/subscriptions/${t.id}/change`, { ...t.base, term: 'yearly', addOns: X }));
    check('An interval change reserves nothing more, even at the ceiling (CASE 12)', !yearly.refused, yearly.message.slice(-80));

    await POST(`/x-addon/${t.id}/cancel`);
    await PUT('/policy', { constraints: { xCommercialCeilingUnits: used + 1999 } });
    const resume = await refused(() => POST(`/x-addon/${t.id}/resume`), /capacity is full/);
    check('Resume also needs a reservation', resume.refused);
    check('…and stays FROZEN when refused', (await state(t.id)).xAddon.status === 'FROZEN');
    await POST('/policy/presets/scio_portal_mvp');
    t.done = true;
  });

  await scenario('G', 'A declined card leaves nothing behind', async () => {
    const t = await tenant('g', at(2026, 9, 1));
    await POST(`/accounts/${t.id}/payment-method/test`, { kind: 'charge_fails' });
    const r = await refused(() => buyX(t));
    check('Purchase refused by error_if_incomplete', r.refused, r.message.slice(-90));
    const s = await state(t.id);
    check('No X item, no quota, no reservation (row 53)', !hasXItem(s) && s.xAddon.status === 'NONE' && !s.xAddon.ledger && s.xAddon.capacity.mine === null,
      s.xAddon.status);
    t.done = true;
  });

  await scenario('H', 'Trial: 14 days, 200 posts, Manual only, once per account, no Stripe item', async () => {
    const t = await tenant('h', at(2026, 9, 1));
    const started = await POST(`/x-addon/${t.id}/trial`);
    const xs = started.xAddon;
    check('TRIALING with 200 Post Updates until 15/09', xs.status === 'TRIALING' && xs.trial.granted === 200 && xs.trial.endsAt === at(2026, 9, 15),
      `${xs.status} · ${xs.trial?.granted} until ${day(xs.trial?.endsAt)}`);
    check('No Stripe item for the trial', !hasXItem(started));
    const auto = await refused(() => sync(t.id, { kind: 'auto', returned: 5 }), /Manual Refresh only/);
    check('Auto Sync refused on trial', auto.refused);
    const manual = await sync(t.id, { kind: 'manual', returned: 30 });
    check('Manual Refresh spends the trial ledger', manual.run.charged === 30 && manual.state.xAddon.trial.remaining === 170);
    const again = await refused(() => POST(`/x-addon/${t.id}/trial`), /once per account/);
    check('A second trial is refused', again.refused);

    await advance(t.id, at(2026, 9, 10));
    const bought = (await buyX(t)).state.xAddon;
    check('Buying ends the trial; its 170 are not carried over (row 50)', bought.status === 'ACTIVE' && !bought.trial.live && bought.ledger?.granted === Math.floor((2000 * 21) / 30),
      `${bought.status} · paid ${bought.ledger?.granted}`);

    const u = await tenant('h2', at(2026, 9, 1));
    await POST(`/x-addon/${u.id}/trial`);
    const expired = (await advance(u.id, at(2026, 9, 16))).state.xAddon;
    check('The trial ends after 14 days and cannot restart', expired.status === 'NONE' && expired.trialAvailable === false, expired.status);
    t.done = true;
  });

  await scenario('I', 'Base plan to Free: X runs to the base boundary, then ends with it', async () => {
    const t = await tenant('i', at(2026, 9, 10));
    await buyX(t);
    const toFree = await POST(`/subscriptions/${t.id}/change`, { planCode: 'free', term: 'monthly', screens: 1, addOns: [] });
    check('Downgrade to Free is scheduled for 10/10, not now (row 67)', toFree.state.stripe.cancelAtPeriodEnd === true && toFree.state.xAddon.status === 'ACTIVE');
    const oct = (await advance(t.id, at(2026, 10, 2))).state.xAddon;
    check('October granted only up to the boundary: 580', oct.ledger?.granted === 580 && oct.status === 'ACTIVE', `${oct.ledger?.granted}`);
    const ended = (await advance(t.id, at(2026, 10, 10, 1))).state.xAddon;
    check('At the boundary X ends with the base (row 55)', ended.status === 'ENDED' && !ended.canFetchNewPosts && !ended.fanOut, ended.status);
    check('Capacity released', ended.capacity.mine === null);
    t.done = true;
  });

  await scenario('J', 'Webhook replay and a quantity drift on Stripe', async () => {
    const t = await tenant('j', at(2026, 9, 1));
    const bought = (await buyX(t)).state;
    const acct = await GET(`/accounts/${t.id}`);
    const inv = (await invoices(t.id))[0];
    const payload = { id: `evt_replay_${Date.now()}`, type: 'invoice.paid', data: { object: { id: inv.id, number: inv.number, customer: acct.stripeCustomerId, amount_paid: inv.amountPaid, currency: 'usd' } } };
    await POST('/webhooks/stripe', payload);
    await POST('/webhooks/stripe', payload);
    const replay = (await state(t.id)).xAddon;
    check('invoice.paid delivered twice grants nothing twice (row 51)', replay.ledger?.granted === 2000 && replay.ledger.grants.length === 1,
      `${replay.ledger?.granted} · ${replay.ledger?.grants.length} grant(s)`);

    const item = bought.stripe.items.find((i) => i.id === bought.xAddon.itemId);
    await stripe.subscriptions.update(bought.stripe.id, { items: [{ id: item.id, quantity: 2 }], proration_behavior: 'none' });
    const fixed = (await state(t.id)).xAddon;
    const live = await stripe.subscriptions.retrieve(bought.stripe.id);
    check('Quantity 2 found on Stripe is put back to 1 (EASY 5)', live.items.data.find((i) => i.id === item.id).quantity === 1);
    check('…with an alert and no extra quota', Boolean(fixed.quantityAlert) && fixed.ledger?.granted === 2000, fixed.quantityAlert);
    const events = await GET(`/events?accountId=${t.id}&limit=100`);
    check('The alert is in the audit log', events.some((e) => e.action === 'x.quantity_reconciled'));
    t.done = true;
  });

  await scenario('K', 'X needs a paid base plan', async () => {
    const account = await POST('/accounts', { email: `x-v6-k-${Date.now()}@optisigns-billing-demo.test`, name: 'X V6 k', withTestClock: true, clockStart: at(2026, 9, 1) });
    created.push(account._id);
    await POST(`/subscriptions/${account._id}/change`, { planCode: 'standard', term: 'monthly', screens: 1, addOns: [] });
    const s = await state(account._id);
    check('Base on a Stripe trial (no card on file)', s.stripe.status === 'trialing', s.stripe.status);
    const r = await refused(() => POST(`/subscriptions/${account._id}/change`, { planCode: 'standard', term: 'monthly', screens: 1, addOns: X }), /paid base plan/);
    check('X refused while the base plan is trialing (row 18)', r.refused, r.message.slice(-80));
    const fresh = await POST('/accounts', { email: `x-v6-k2-${Date.now()}@optisigns-billing-demo.test`, name: 'X V6 k2', withTestClock: true });
    created.push(fresh._id);
    await POST(`/accounts/${fresh._id}/payment-method/test`, { kind: 'visa' });
    const r2 = await refused(() => POST(`/subscriptions/${fresh._id}/change`, { planCode: 'standard', term: 'monthly', screens: 1, addOns: X }), /base plan first/);
    check('X is not bundled into a brand-new subscription', r2.refused, r2.message.slice(-80));
  });

  await POST('/policy/presets/optisigns_default');
  if (!KEEP) {
    for (const id of created) await DELETE(`/accounts/${id}`).catch(() => {});
    console.log(c.dim(`\n  ${created.length} demo tenant(s) deleted (pass --keep to inspect them in Stripe)`));
  }
  console.log(failures === 0 ? `\n${c.ok(`All ${passes} X V6 checks passed.`)}` : `\n${c.bad(`${failures} check(s) failed`)} (${passes} passed).`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((err) => {
  console.error(`\n${c.bad('Verification aborted:')} ${err.message}`);
  process.exit(1);
});
