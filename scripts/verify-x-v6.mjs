#!/usr/bin/env node
/**
 * The X add-on against MODEL V6, end to end on real Stripe test-mode objects.
 * Every scenario runs on its own tenant bound to a Stripe test clock, so each
 * base plan's billing_cycle_anchor is the tenant's clock start.
 *
 * The quota cycle is stepped from the base plan's billing cycle anchor as it
 * was when X was bought, so a quota month is the billing month — 20/09 → 20/10
 * on a plan billed on the 20th, not a calendar month. Only a base-plan interval
 * change makes the two run apart: Stripe restarts billing, the quota cycle keeps
 * its anchor (scenarios E and Q).
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
// row 59: there is no resume route — buying X again goes through the ordinary purchase
const previewBuyX = (t, extra = {}) => POST(`/subscriptions/${t.id}/preview`, { ...t.base, ...extra, addOns: X });
const sync = (id, body) => POST(`/x-addon/${id}/sync-runs`, body);
const invoices = (id) => GET(`/billing/accounts/${id}/invoices`);
const balance = async (id) => (await GET(`/accounts/${id}/balance`)).balance;
const hasXItem = (s) => (s.current.addOns ?? []).some((a) => a.code === 'x_social');
// rows 49, 51: after a Cancel the same X item stays on Stripe at quantity 0 until AlreadyPaidUntil
let X_PRODUCT = null;
let X_PRICES = {};
const xOnStripe = async (id) => {
  const s = await state(id);
  const sub = await stripe.subscriptions.retrieve(s.stripe.id);
  return sub.items.data.filter((i) => (typeof i.price.product === 'string' ? i.price.product : i.price.product?.id) === X_PRODUCT);
};
const xAmount = (inv) => (inv?.lines ?? []).filter((l) => /X Social/.test(l.description ?? '')).reduce((s, l) => s + l.amount, 0);
const hasXLine = (inv) => (inv?.lines ?? []).some((l) => /X Social/.test(l.description ?? ''));

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
  X_PRODUCT = x?.stripeProductId;
  X_PRICES = { monthly: x?.monthlyPrice?.priceId, yearly: x?.yearlyPrice?.priceId };
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

  await scenario('B', 'Billing anchored on the 10th: the quota month IS the billing month; renewal, payment failure, paid retry', async () => {
    const t = await tenant('b', at(2026, 9, 10));
    const bought = (await buyX(t)).state.xAddon;
    check('Bought on 10/09 at the start of the billing month: the whole 2,000', bought.ledger?.granted === 2000, `${bought.ledger?.granted}`);
    check('The quota month follows the base plan: 10/09 → 10/10, not 01/09 → 01/10',
      bought.quotaMonth.start === at(2026, 9, 10) && bought.quotaMonth.end === at(2026, 10, 10) && bought.quotaAnchor === at(2026, 9, 10),
      `${day(bought.quotaMonth.start)} → ${day(bought.quotaMonth.end)}`);

    const early = (await advance(t.id, at(2026, 10, 2))).state.xAddon;
    check('On 02/10 it is still the same quota month and still 2,000 — no calendar split at 01/10', early.ledger?.granted === 2000 && early.quotaMonth.start === at(2026, 9, 10),
      `${early.ledger?.granted} · ${day(early.quotaMonth.start)}`);
    check('Nothing is paid short of the quota month, so no "paid through" warning', !early.warnings.some((w) => /Paid through/.test(w)), early.warnings[0] ?? 'none');
    await sync(t.id, { kind: 'auto', returned: 100, actionId: 'b-1' });

    const renewed = (await advance(t.id, at(2026, 10, 10, 1))).state.xAddon;
    check('Renewal paid on 10/10 opens the next quota month at 2,000', renewed.ledger?.granted === 2000 && renewed.quotaMonth.start === at(2026, 10, 10),
      `${renewed.ledger?.granted} · ${day(renewed.quotaMonth.start)}`);
    check('Used starts at 0 — the previous month\'s leftover does not roll over', renewed.ledger?.used === 0, `used ${renewed.ledger?.used}`);

    await POST(`/accounts/${t.id}/payment-method/test`, { kind: 'charge_fails' });
    const failed = (await advance(t.id, at(2026, 11, 10, 1))).state;
    const xs = failed.xAddon;
    check('Renewal 10/11 fails: Stripe keeps it open', failed.stripe.status === 'past_due', failed.stripe.status);
    check('The quota month 10/11 → 10/12 has no paid time, so nothing is granted (row 53)', (xs.ledger?.granted ?? 0) === 0, `${xs.ledger?.granted ?? 0}`);
    check('Past paidThrough nothing is fetched (PAYMENT_PENDING)', xs.status === 'PAYMENT_PENDING' && !xs.canFetchNewPosts, xs.status);
    const blocked = await refused(() => sync(t.id, { kind: 'auto', returned: 5 }), /PAYMENT_PENDING/);
    check('A sync run is refused, nothing charged', blocked.refused && blocked.status === 409);

    await POST(`/accounts/${t.id}/payment-method/test`, { kind: 'visa' });
    const open = (await invoices(t.id)).find((i) => i.status === 'open');
    await POST(`/billing/invoices/${open.id}/pay`);
    const paid = (await state(t.id)).xAddon;
    check('Paid on retry: ACTIVE, the month granted 2,000, Used 0 (EASY 4)', paid.status === 'ACTIVE' && paid.ledger?.granted === 2000 && paid.ledger?.used === 0,
      `${paid.status} · ${paid.ledger?.granted} / used ${paid.ledger?.used}`);
    t.done = true;
  });

  await scenario('C', 'Monthly cancel with no future coverage, then Buy X again inside and after the quota month', async () => {
    const t = await tenant('c', at(2026, 9, 1));
    const itemId = (await buyX(t)).state.xAddon.itemId;
    await sync(t.id, { kind: 'initial', returned: 300, actionId: 'c-1' });
    await advance(t.id, at(2026, 9, 10));

    const before = await balance(t.id);
    const invCount = (await invoices(t.id)).length;
    const pv = await POST(`/x-addon/${t.id}/preview/cancel`);
    check('Cancel preview: quotaMonthEnd 01/10 is not before xPaidThrough 01/10 → no-proration, no credit (row 49)', pv.stripeParams.proration_behavior === 'none' && !pv.invoice);
    const cancelled = (await POST(`/x-addon/${t.id}/cancel`)).state;
    const xs = cancelled.xAddon;
    check('Cancel takes effect now: X no longer active, base untouched', !hasXItem(cancelled) && cancelled.stripe.status === 'active');
    const parked = await xOnStripe(t.id);
    check('…and the same X item stays on Stripe at quantity 0, not deleted (row 49)', parked.length === 1 && parked[0].id === itemId && parked[0].quantity === 0,
      parked.map((i) => `${i.id} ×${i.quantity}`).join(' '));
    check('Kept until AlreadyPaidUntil = min(oldPaidThrough 01/10, quotaMonthEnd 01/10) = 01/10', xs.parkedItem?.alreadyPaidUntil === at(2026, 10, 1),
      day(xs.parkedItem?.alreadyPaidUntil));
    check('FROZEN until quotaMonthEnd 01/10, fan-out off', xs.status === 'FROZEN' && xs.frozen?.until === at(2026, 10, 1) && !xs.fanOut && !xs.canFetchNewPosts,
      `${xs.status} until ${day(xs.frozen?.until)}`);
    check('No future paid coverage, so no credit (row 7)', (await balance(t.id)) === before && (await invoices(t.id)).length === invCount, money(before));
    check('Capacity released', xs.capacity.mine === null);
    const frozenRun = await refused(() => sync(t.id, { kind: 'manual', returned: 1 }), /FROZEN/);
    check('A frozen tenant fetches nothing', frozenRun.refused);

    await advance(t.id, at(2026, 9, 15));
    const gone = await refused(() => POST(`/x-addon/${t.id}/resume`), /404|Cannot POST/);
    check('There is no separate restore route (row 59)', gone.refused, gone.message.slice(-60));
    const rp = await previewBuyX(t);
    check('Buy X again preview: already paid until 01/10 → proration none, nothing charged twice (EASY 1)',
      rp.mode === 'x_repurchase' && rp.stripeParams.proration_behavior === 'none' && !rp.invoice, rp.explanation[1]);
    const rebought = (await buyX(t)).state.xAddon;
    check('Bought again inside the quota month: FrozenRemaining restored, 2,000 / 300 (row 59)', rebought.status === 'ACTIVE' && rebought.ledger?.granted === 2000 && rebought.ledger?.used === 300,
      `${rebought.status} · ${rebought.ledger?.granted} / ${rebought.ledger?.used}`);
    check('No invoice for buying it again', (await invoices(t.id)).length === invCount);
    const back = await xOnStripe(t.id);
    check('The same item went back from quantity 0 to 1 (row 59)', back.length === 1 && back[0].id === itemId && back[0].quantity === 1,
      back.map((i) => `${i.id} ×${i.quantity}`).join(' '));
    check('Capacity reserved again', rebought.capacity.mine?.status === 'committed');

    await advance(t.id, at(2026, 9, 20));
    await POST(`/x-addon/${t.id}/cancel`);
    // hold the cleanup back so buying X again and the cleanup meet at the boundary
    await PUT('/policy', { constraints: { xCleanupPaused: true } });
    const later = (await advance(t.id, at(2026, 10, 5))).state.xAddon;
    check('After quotaMonthEnd it is CANCELED — the old quota expired', later.status === 'CANCELED' && later.repurchase?.kind === 'new_activation',
      `${later.status} · ${later.repurchase?.kind}`);
    const renewal = (await invoices(t.id)).find((i) => i.billingReason === 'subscription_cycle');
    check('The 01/10 renewal charges nothing for the quantity-0 item', xAmount(renewal) === 0,
      `${renewal?.number ?? '—'} X ${money(xAmount(renewal))}${hasXLine(renewal) ? ' (a $0 X line is on it: the renewal ran before the cleanup could)' : ''}`);
    await POST('/policy/presets/scio_portal_mvp');
    const invBefore = (await invoices(t.id)).length;
    const [raced] = await Promise.all([buyX(t), state(t.id), state(t.id), state(t.id)]);
    const react = raced.state;
    const after = await xOnStripe(t.id);
    check('Buying X again racing three reads of the cleanup: exactly one X item, at quantity 1 (row 8)',
      after.length === 1 && after[0].quantity === 1 && react.xAddon.status === 'ACTIVE',
      after.map((i) => `${i.id === itemId ? 'same' : 'new'} ${i.id} ×${i.quantity}`).join(' '));
    const inv = (await invoices(t.id))[0];
    check('…charged once, from 05/10 to the 01/11 boundary', (await invoices(t.id)).length === invBefore + 1 && inv.status === 'paid' && near(inv.total, Math.round((2000 * 27) / 31)),
      `${inv.number} ${money(inv.total)}`);
    check('October granted by paid coverage: floor(2,000 × 27/31) = 1,741, Used 0', react.xAddon.ledger?.granted === 1741 && react.xAddon.ledger?.used === 0,
      `${react.xAddon.ledger?.granted} / ${react.xAddon.ledger?.used}`);
    t.done = true;
  });

  await scenario('D', 'Yearly from the start: quota months on the 5th, cancel credit from quotaMonthEnd, Buy X again debits it back', async () => {
    const t = await tenant('d', at(2026, 9, 5), { term: 'yearly' });
    const bought = await buyX(t);
    const itemId = bought.state.xAddon.itemId;
    check('Annual bought 05/09: the quota month is 05/09 → 05/10, a whole 2,000', bought.state.xAddon.ledger?.granted === 2000 &&
      bought.state.xAddon.quotaMonth.start === at(2026, 9, 5) && bought.state.xAddon.quotaMonth.end === at(2026, 10, 5),
      `${bought.state.xAddon.ledger?.granted} · ${day(bought.state.xAddon.quotaMonth.start)} → ${day(bought.state.xAddon.quotaMonth.end)}`);
    const buyInv = (await invoices(t.id))[0];
    check('$216 charged for the year', buyInv.status === 'paid' && near(buyInv.total, 21600), money(buyInv.total));

    await advance(t.id, at(2026, 9, 20));
    const before = await balance(t.id);
    const pv = await POST(`/x-addon/${t.id}/preview/cancel`);
    check('Cancel preview: proration_date = quotaMonthEnd 05/10', pv.stripeParams.proration_date === at(2026, 10, 5), day(pv.stripeParams.proration_date));
    const cancelled = (await POST(`/x-addon/${t.id}/cancel`)).state;
    const credit = before - (await balance(t.id));
    const expected = Math.round((21600 * (at(2027, 9, 5) - at(2026, 10, 5))) / (at(2027, 9, 5) - at(2026, 9, 5)));
    check('Stripe credits 05/10/2026 → 05/09/2027 to the customer balance (row 7)', near(credit, expected, 2), `${money(credit)} ≈ ${money(expected)}`);
    check('The quota month in progress stays granted and FROZEN', cancelled.xAddon.status === 'FROZEN' && cancelled.xAddon.ledger?.granted === 2000);
    const parked = await xOnStripe(t.id);
    check('Yearly too: the same item at quantity 0 until quotaMonthEnd 05/10', parked.length === 1 && parked[0].id === itemId && parked[0].quantity === 0 &&
      cancelled.xAddon.parkedItem?.alreadyPaidUntil === at(2026, 10, 5), day(cancelled.xAddon.parkedItem?.alreadyPaidUntil));

    await advance(t.id, at(2026, 9, 25));
    const rp = await previewBuyX(t);
    check('Buying X again re-debits from the same boundary, on the same item 0 → 1', rp.stripeParams.proration_date === at(2026, 10, 5) && rp.stripeParams.proration_behavior === 'always_invoice' && rp.stripeParams.items[0].id === itemId,
      `${day(rp.stripeParams.proration_date)} · ${rp.stripeParams.proration_behavior}`);
    const rebought = (await buyX(t)).state.xAddon;
    const inv = (await invoices(t.id))[0];
    check('The buy-again invoice equals the credit, paid from the balance', near(inv.total, credit, 2) && inv.amountDue === 0 && inv.status === 'paid',
      `${inv.number} ${money(inv.total)} due ${money(inv.amountDue)}`);
    check('Balance back where it was, no card charge', near(await balance(t.id), before, 2), money(await balance(t.id)));
    check('Same ledger: 2,000 granted, not granted again', rebought.status === 'ACTIVE' && rebought.ledger?.granted === 2000,
      `${rebought.status} · ${rebought.ledger?.granted}`);
    check('Coverage is one continuous year again', rebought.coverage.length === 1 && rebought.coverage[0].end === at(2027, 9, 5),
      JSON.stringify(rebought.coverage.map((i) => `${day(i.start)}→${day(i.end)}`)));
    t.done = true;
  });

  await scenario('E', 'Interval change: billing restarts, the quota cycle keeps its anchor; X left out while frozen', async () => {
    const t = await tenant('e', at(2026, 9, 15));
    const first = (await buyX(t)).state.xAddon;
    const itemId = first.itemId;
    check('Bought on 15/09 on a base plan billed on the 15th: quota month 15/09 → 15/10, 2,000',
      first.ledger?.granted === 2000 && first.quotaMonth.start === at(2026, 9, 15) && first.quotaAnchor === at(2026, 9, 15),
      `${first.ledger?.granted} · ${day(first.quotaMonth.start)} → ${day(first.quotaMonth.end)}`);
    await sync(t.id, { kind: 'auto', returned: 100, actionId: 'e-1' });
    await advance(t.id, at(2026, 9, 20));

    const yearly = await POST(`/subscriptions/${t.id}/change`, { ...t.base, term: 'yearly', addOns: X });
    const inv = (await invoices(t.id))[0];
    const xLines = inv.lines.filter((l) => /X Social/.test(l.description ?? ''));
    check('X moves to yearly with the base, prorated by Stripe (row 60)',
      yearly.state.current.term === 'yearly' && xLines.some((l) => l.amount < 0) && xLines.some((l) => l.amount > 0),
      xLines.map((l) => money(l.amount)).join(' '));
    const xs = yearly.state.xAddon;
    const liveSub = await stripe.subscriptions.retrieve(yearly.state.stripe.id);
    check('Stripe restarted billing on 20/09 (billing_cycle_anchor = now)', liveSub.billing_cycle_anchor === at(2026, 9, 20), day(liveSub.billing_cycle_anchor));
    check('…but the quota cycle keeps its anchor: still 15/09 → 15/10, not 20/09 → 20/10',
      xs.quotaAnchor === at(2026, 9, 15) && xs.quotaMonth.start === at(2026, 9, 15) && xs.quotaMonth.end === at(2026, 10, 15),
      `anchor ${day(xs.quotaAnchor)} · ${day(xs.quotaMonth.start)} → ${day(xs.quotaMonth.end)}`);
    check('The switch grants no second time: still 2,000 (CASE 9)', xs.ledger?.granted === 2000, `${xs.ledger?.granted}`);
    check('Used 100 kept', xs.ledger?.used === 100);
    check('Paid coverage now runs to 20/09/2027', xs.coverage.at(-1)?.end === at(2027, 9, 20), day(xs.coverage.at(-1)?.end));

    await advance(t.id, at(2026, 9, 22));
    await POST(`/x-addon/${t.id}/cancel`);
    await advance(t.id, at(2026, 9, 23));
    const monthly = await POST(`/subscriptions/${t.id}/change`, { ...t.base, term: 'monthly', addOns: [] });
    const inv2 = (await invoices(t.id))[0];
    const frozenItem = await xOnStripe(t.id);
    check('While frozen, the base changes interval and X is neither charged nor credited (row 64)',
      monthly.state.current.term === 'monthly' && xAmount(inv2) === 0 && monthly.state.xAddon.status === 'FROZEN',
      `${monthly.state.xAddon.status} · X ${money(xAmount(inv2))}`);
    check('The quantity-0 item follows the monthly price and stays at quantity 0 (CASE 9)',
      frozenItem.length === 1 && frozenItem[0].id === itemId && frozenItem[0].quantity === 0 && frozenItem[0].price.id === X_PRICES.monthly,
      frozenItem.map((i) => `${i.id} ×${i.quantity} ${i.price.recurring?.interval}`).join(' '));
    await advance(t.id, at(2026, 9, 24));
    const rp = await previewBuyX(t);
    check('Buying X again charges from where the yearly credit started (quotaMonthEnd 15/10), on the new monthly price',
      rp.stripeParams.proration_date === at(2026, 10, 15) && rp.stripeParams.items[0].price !== undefined,
      `${day(rp.stripeParams.proration_date)}`);
    const rebought = (await buyX(t)).state.xAddon;
    const inv3 = (await invoices(t.id))[0];
    const same = await xOnStripe(t.id);
    check('Bought again on the same item, back to quantity 1', same.length === 1 && same[0].id === itemId && same[0].quantity === 1);
    const expected = Math.round((2000 * (at(2026, 10, 23) - at(2026, 10, 15))) / (at(2026, 10, 23) - at(2026, 9, 23)));
    check('Charged 15/10 → 23/10 at $20/month', near(inv3.total, expected, 2), `${money(inv3.total)} ≈ ${money(expected)}`);
    check('The frozen quota month 15/09 → 15/10 is back unchanged: 2,000 / 100, on the original anchor',
      rebought.ledger?.granted === 2000 && rebought.ledger?.used === 100 && rebought.quotaAnchor === at(2026, 9, 15),
      `${rebought.ledger?.granted} / ${rebought.ledger?.used} · anchor ${day(rebought.quotaAnchor)}`);
    t.done = true;
  });

  await scenario('Q', 'After an interval change the quota cycle and the billing cycle run apart', async () => {
    const t = await tenant('q', at(2026, 9, 15));
    await buyX(t);
    await advance(t.id, at(2026, 9, 20));
    await POST(`/subscriptions/${t.id}/change`, { ...t.base, term: 'yearly', addOns: X });
    const oct = (await advance(t.id, at(2026, 10, 16))).state;
    const sub = await stripe.subscriptions.retrieve(oct.stripe.id);
    const period = sub.items.data[0];
    check('Billing is one yearly period 20/09/2026 → 20/09/2027',
      period.current_period_start === at(2026, 9, 20) && period.current_period_end === at(2027, 9, 20),
      `${day(period.current_period_start)} → ${day(period.current_period_end)}`);
    const xs = oct.xAddon;
    check('…while the quota months stay monthly on the 15th: 15/10 → 15/11',
      xs.quotaMonth.start === at(2026, 10, 15) && xs.quotaMonth.end === at(2026, 11, 15),
      `${day(xs.quotaMonth.start)} → ${day(xs.quotaMonth.end)}`);
    check('That month is paid by the year, so it is a fresh 2,000 with Used 0', xs.ledger?.granted === 2000 && xs.ledger?.used === 0,
      `${xs.ledger?.granted} / ${xs.ledger?.used}`);
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
    // the subscription moved to yearly above, so buying again asks for the yearly term
    const again = await refused(() => buyX(t, { term: 'yearly' }), /capacity is full/);
    check('Buying X again also needs a reservation', again.refused);
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
    check('Before the boundary the quota month 10/09 → 10/10 is paid in full: 2,000', oct.ledger?.granted === 2000 && oct.status === 'ACTIVE' && oct.quotaMonth.end === at(2026, 10, 10),
      `${oct.ledger?.granted} · until ${day(oct.quotaMonth.end)}`);
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

    await stripe.subscriptions.update(bought.stripe.id, { items: [{ id: item.id, quantity: 0 }], proration_behavior: 'none' });
    const zero = (await state(t.id)).xAddon;
    check('Quantity 0 with no Cancel recorded: not ACTIVE, alerted, nothing granted (EASY 5)',
      zero.status !== 'ACTIVE' && /without a Cancel/.test(zero.quantityAlert ?? '') && !zero.canFetchNewPosts, `${zero.status} · ${zero.quantityAlert}`);
    t.done = true;
  });

  await scenario('L', 'Monthly billing anchored on the 20th: a Cancel has nothing to credit; Buy X again after quotaMonthEnd starts on the base cycle', async () => {
    const t = await tenant('l', at(2026, 9, 20));
    await buyX(t);
    await advance(t.id, at(2026, 9, 25));
    const before = await balance(t.id);
    const pv = await POST(`/x-addon/${t.id}/preview/cancel`);
    check('quotaMonthEnd 20/10 is xPaidThrough 20/10 — no future paid coverage → no-proration, no credit (row 49)',
      pv.stripeParams.proration_behavior === 'none' && !pv.invoice, pv.stripeParams.proration_behavior);
    const cancelled = (await POST(`/x-addon/${t.id}/cancel`)).state;
    check('Nothing credited', (await balance(t.id)) === before, money(await balance(t.id)));
    check('The quota month 20/09 → 20/10 stays granted and FROZEN', cancelled.xAddon.status === 'FROZEN' && cancelled.xAddon.ledger?.granted === 2000 &&
      cancelled.xAddon.frozen?.until === at(2026, 10, 20), `${cancelled.xAddon.status} · ${cancelled.xAddon.ledger?.granted} until ${day(cancelled.xAddon.frozen?.until)}`);
    check('Kept until AlreadyPaidUntil = min(oldPaidThrough 20/10, quotaMonthEnd 20/10) = 20/10', cancelled.xAddon.parkedItem?.alreadyPaidUntil === at(2026, 10, 20),
      day(cancelled.xAddon.parkedItem?.alreadyPaidUntil));

    await advance(t.id, at(2026, 10, 25));
    const later = (await state(t.id)).xAddon;
    check('Past quotaMonthEnd the frozen quota has expired', later.status === 'CANCELED' && later.repurchase?.kind === 'new_activation', later.status);
    check('Past AlreadyPaidUntil 20/10 the quantity-0 item was cleaned up', (await xOnStripe(t.id)).length === 0 && Boolean(later.cleanedUpAt) && !later.parkedItem,
      day(later.cleanedUpAt));
    const bought = (await buyX(t)).state.xAddon;
    const inv = (await invoices(t.id))[0];
    const charge = Math.round((2000 * (at(2026, 11, 20) - at(2026, 10, 25))) / (at(2026, 11, 20) - at(2026, 10, 20)));
    check('Bought again on 25/10: Stripe charges 25/10 → 20/11 (row 59, example 2)', near(inv.total, charge, 2), `${money(inv.total)} ≈ ${money(charge)}`);
    check('A new activation follows the base cycle: quota month 20/10 → 20/11', bought.quotaMonth.start === at(2026, 10, 20) && bought.quotaMonth.end === at(2026, 11, 20),
      `${day(bought.quotaMonth.start)} → ${day(bought.quotaMonth.end)}`);
    check('Granted by the new paid coverage: floor(2,000 × 26/31) = 1,677', bought.ledger?.granted === 1677, `${bought.ledger?.granted}`);
    const fresh = await xOnStripe(t.id);
    check('…on a new item, since the old one is gone', fresh.length === 1 && fresh[0].quantity === 1 && fresh[0].id !== cancelled.xAddon.parkedItem?.id);
    t.done = true;
  });

  await scenario('M', 'Anchor on the 5th: a first purchase inside one billing month, then Buy X again before paidThrough', async () => {
    const t = await tenant('m', at(2026, 8, 5));
    await advance(t.id, at(2026, 8, 30));
    const aug = (await buyX(t)).state.xAddon;
    check('Bought 30/08 with the billing boundary 05/09: one quota month 05/08 → 05/09, floor(2,000 × 6/31) = 387',
      aug.ledger?.granted === 387 && aug.quotaMonth.start === at(2026, 8, 5) && aug.quotaMonth.end === at(2026, 9, 5),
      `${aug.ledger?.granted} · ${day(aug.quotaMonth.start)} → ${day(aug.quotaMonth.end)}`);
    const sep = (await advance(t.id, at(2026, 9, 2))).state.xAddon;
    check('01/09 is no boundary: still the same quota month at 387, not split into 129 + 266', sep.ledger?.granted === 387 && sep.quotaMonth.start === at(2026, 8, 5),
      `${sep.ledger?.granted} · ${day(sep.quotaMonth.start)}`);
    await sync(t.id, { kind: 'auto', returned: 50, actionId: 'm-1' });
    const before = await balance(t.id);
    const pv = await POST(`/x-addon/${t.id}/preview/cancel`);
    check('quotaMonthEnd 05/09 is xPaidThrough 05/09 → no-proration, no credit', pv.stripeParams.proration_behavior === 'none');
    const cancelledM = (await POST(`/x-addon/${t.id}/cancel`)).state.xAddon;
    check('Nothing credited', (await balance(t.id)) === before);
    check('AlreadyPaidUntil = min(oldPaidThrough 05/09, quotaMonthEnd 05/09) = 05/09', cancelledM.parkedItem?.alreadyPaidUntil === at(2026, 9, 5),
      day(cancelledM.parkedItem?.alreadyPaidUntil));
    await advance(t.id, at(2026, 9, 4));
    const rp = await previewBuyX(t);
    check('Buy X again on 04/09: already paid until 05/09 — nothing charged now (row 59, example 1)',
      rp.stripeParams.proration_behavior === 'none' && !rp.invoice, rp.explanation[1]);
    const invCount = (await invoices(t.id)).length;
    const again = (await buyX(t)).state.xAddon;
    check('FrozenRemaining restored: 387 / 50, no invoice', again.status === 'ACTIVE' && again.ledger?.granted === 387 && again.ledger?.used === 50 && (await invoices(t.id)).length === invCount,
      `${again.ledger?.granted} / ${again.ledger?.used}`);
    const mItem = await xOnStripe(t.id);
    check('…on the same item, quantity 0 → 1', mItem.length === 1 && mItem[0].id === cancelledM.parkedItem?.id && mItem[0].quantity === 1);
    const renewed = (await advance(t.id, at(2026, 9, 5, 1))).state;
    const inv = (await invoices(t.id))[0];
    check('On 05/09 the X item renews and is charged normally', inv.status === 'paid' && inv.lines.some((l) => /X Social/.test(l.description ?? '') && l.amount > 0),
      `${inv.number} ${money(inv.total)}`);
    check('The renewal opens the next quota month 05/09 → 05/10 at 2,000, Used 0', renewed.xAddon.ledger?.granted === 2000 && renewed.xAddon.ledger?.used === 0 &&
      renewed.xAddon.quotaMonth.start === at(2026, 9, 5), `${renewed.xAddon.ledger?.granted} / ${renewed.xAddon.ledger?.used} · ${day(renewed.xAddon.quotaMonth.start)}`);
    t.done = true;
  });

  await scenario('N', 'The quantity-0 item: kept to AlreadyPaidUntil, cleaned up with no proration, retried for 24 hours, reused while it lasts', async () => {
    const t = await tenant('n', at(2026, 9, 20));
    const itemId = (await buyX(t)).state.xAddon.itemId;
    await advance(t.id, at(2026, 9, 25));
    await POST(`/x-addon/${t.id}/cancel`);
    let items = await xOnStripe(t.id);
    check('Cancel on 25/09: same item at quantity 0, kept until AlreadyPaidUntil 20/10', items.length === 1 && items[0].id === itemId && items[0].quantity === 0 &&
      (await state(t.id)).xAddon.parkedItem?.alreadyPaidUntil === at(2026, 10, 20));

    await PUT('/policy', { constraints: { xCleanupPaused: true } });
    const failing = (await advance(t.id, at(2026, 10, 20, 1))).state.xAddon;
    items = await xOnStripe(t.id);
    check('A cleanup that fails at the boundary leaves the item at 0 and is retried', items.length === 1 && items[0].quantity === 0 && Boolean(failing.parkedItem?.cleanupError),
      failing.parkedItem?.cleanupError ?? '');
    const overdue = (await advance(t.id, at(2026, 10, 21, 2))).state.xAddon;
    const events = await GET(`/events?accountId=${t.id}&limit=200`);
    check('Still failing 24 hours after the boundary: an operational alert', events.some((e) => e.action === 'x.cleanup_overdue') && overdue.warnings.some((w) => /24 hours/.test(w)));

    const rp = await previewBuyX(t);
    check('Buying X again past AlreadyPaidUntil, item still there: reuse it, prorated normally from now (row 59)',
      rp.stripeParams.items[0].id === itemId && rp.stripeParams.proration_date === at(2026, 10, 21, 2) && rp.stripeParams.proration_behavior === 'always_invoice' && rp.explanation[0].includes('new activation'),
      `${rp.stripeParams.items[0].id ?? 'new item'} · ${day(rp.stripeParams.proration_date)}`);
    const again = (await buyX(t)).state.xAddon;
    items = await xOnStripe(t.id);
    const inv = (await invoices(t.id))[0];
    const charge = Math.round((2000 * (at(2026, 11, 20) - at(2026, 10, 21, 2))) / (at(2026, 11, 20) - at(2026, 10, 20)));
    check('Same item 0 → 1, charged 21/10 02:00 → 20/11', items.length === 1 && items[0].id === itemId && items[0].quantity === 1 && near(inv.total, charge, 2),
      `${money(inv.total)} ≈ ${money(charge)}`);
    const month = Math.floor((2000 * (at(2026, 11, 20) - at(2026, 10, 21, 2))) / (at(2026, 11, 20) - at(2026, 10, 20)));
    check(`The quota month 20/10 → 20/11 granted by that coverage only: ${month}`, again.status === 'ACTIVE' && again.ledger?.granted === month, `${again.ledger?.granted}`);

    await POST('/policy/presets/scio_portal_mvp');
    await advance(t.id, at(2026, 10, 25));
    const c2 = (await POST(`/x-addon/${t.id}/cancel`)).state.xAddon;
    check('Cancel on 25/10, xPaidThrough 20/11 = quotaMonthEnd 20/11: no credit, kept until 20/11', c2.parkedItem?.alreadyPaidUntil === at(2026, 11, 20),
      day(c2.parkedItem?.alreadyPaidUntil));
    const boundary = (await advance(t.id, at(2026, 11, 20, 1))).state.xAddon;
    const renewal = (await invoices(t.id))[0];
    check('At AlreadyPaidUntil 20/11 the item is deleted with no proration', (await xOnStripe(t.id)).length === 0 && Boolean(boundary.cleanedUpAt));
    check('The renewal at that boundary charges nothing for X', xAmount(renewal) === 0,
      `${renewal.number} ${money(renewal.total)}${hasXLine(renewal) ? ' — carries a $0 X line: Stripe renewed before the cleanup could run' : ' — no X line'}`);
    await advance(t.id, at(2026, 12, 20, 1));
    const next = (await invoices(t.id))[0];
    check('The next renewal after the cleanup has no X line at all', !hasXLine(next) && next.status === 'paid', `${next.number} ${money(next.total)}`);
    t.done = true;
  });

  await scenario('P', 'Row 59 on the 20th: billing 20/09 → 20/10 IS the quota month, Cancel 25/09 credits nothing, Buy X again 27/09 costs nothing', async () => {
    const t = await tenant('p', at(2026, 9, 20));
    const itemId = (await buyX(t)).state.xAddon.itemId;
    await sync(t.id, { kind: 'auto', returned: 40, actionId: 'p-1' });
    await advance(t.id, at(2026, 9, 25));
    const before = await balance(t.id);
    await POST(`/x-addon/${t.id}/cancel`);
    check('Cancel credits nothing — the whole paid month funded the grant — and keeps the item at quantity 0',
      (await balance(t.id)) === before && (await xOnStripe(t.id))[0]?.quantity === 0, money(before - (await balance(t.id))));
    await advance(t.id, at(2026, 9, 27));
    const invCount = (await invoices(t.id)).length;
    const rp = await previewBuyX(t);
    check('Buy X again 27/09: same item 0 → 1, already paid until 20/10 → proration none',
      rp.stripeParams.items[0].id === itemId && rp.stripeParams.proration_behavior === 'none' && !rp.invoice,
      `${rp.stripeParams.items[0].id} · ${rp.stripeParams.proration_behavior}`);
    const again = (await buyX(t)).state.xAddon;
    check('No invoice for buying it again', (await invoices(t.id)).length === invCount);
    check('FrozenRemaining in use again until 20/10: 2,000 / 40', again.status === 'ACTIVE' && again.ledger?.granted === 2000 && again.ledger?.used === 40,
      `${again.ledger?.granted} / ${again.ledger?.used}`);
    const items = await xOnStripe(t.id);
    check('One X item, the same one, at quantity 1', items.length === 1 && items[0].id === itemId && items[0].quantity === 1);
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
