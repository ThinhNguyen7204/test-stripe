#!/usr/bin/env node
/**
 * The X add-on's quota arithmetic. Pure functions, no Stripe and no Mongo —
 * build the backend first:
 *
 *   (cd backend && npm run build) && node scripts/test-x-quota.mjs
 *
 * The quota cycle is stepped from a per-tenant anchor: the base plan's billing
 * cycle anchor when X is first bought. So the first quota months ARE the base
 * plan's billing months, and only a base-plan interval change — which restarts
 * Stripe's billing cycle but not the quota cycle — makes the two run apart.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const q = require(path.join(here, '../backend/dist/x-addon/quota-math.js'));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label} \x1b[2m${JSON.stringify(actual)}${ok ? '' : ` ≠ ${JSON.stringify(expected)}`}\x1b[0m`);
};
const at = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;
let seq = 0;
const line = (invoiceId, created, amount, start, end, yearly = false) => ({
  invoiceId, created, sequence: ++seq, amount, start, end, yearly,
});

console.log('\n\x1b[1mQuota month is stepped from the anchor\x1b[0m');
{
  const a15 = at(2026, 9, 15);
  check('anchor 15/09: 20/09 is in 15/09 → 15/10', q.quotaMonthOf(at(2026, 9, 20), a15), { start: at(2026, 9, 15), end: at(2026, 10, 15) });
  check('the anchor instant itself opens its month', q.quotaMonthOf(a15, a15), { start: at(2026, 9, 15), end: at(2026, 10, 15) });
  check('before the anchor steps backwards: 10/09 is in 15/08 → 15/09', q.quotaMonthOf(at(2026, 9, 10), a15), { start: at(2026, 8, 15), end: at(2026, 9, 15) });
  check('December rolls into January', q.quotaMonthOf(at(2026, 12, 20), a15), { start: at(2026, 12, 15), end: at(2027, 1, 15) });
  const a31 = at(2026, 1, 31);
  check('a 31st anchor clamps: 31/01 → 28/02', q.quotaMonthOf(at(2026, 2, 10), a31), { start: at(2026, 1, 31), end: at(2026, 2, 28) });
  check('and comes back to the 31st: 28/02 → 31/03', q.quotaMonthOf(at(2026, 3, 5), a31), { start: at(2026, 2, 28), end: at(2026, 3, 31) });
  check('an anchor on the 1st gives calendar months', q.quotaMonthOf(at(2026, 9, 15), at(2026, 9, 1)), { start: at(2026, 9, 1), end: at(2026, 10, 1) });
}

console.log('\n\x1b[1mFirst purchase follows the base plan\'s billing cycle\x1b[0m');
{
  // The reported case: base plan bills on the 17th, X bought 01/10, boundary 17/10.
  // The calendar rule measured 16 paid days against 01/10 → 01/11 and gave 1,032.
  const anchor = at(2026, 9, 17);
  const lines = [line('in_1', at(2026, 10, 1), 1067, at(2026, 10, 1), at(2026, 10, 17))];
  const cov = q.coverageFromLines(lines);
  const month = q.quotaMonthOf(at(2026, 10, 1), anchor);
  check('the quota month is the billing month 17/09 → 17/10', month, { start: at(2026, 9, 17), end: at(2026, 10, 17) });
  check('16 paid days of a 30-day billing month: floor(2,000 × 16/30) = 1,066', q.grantedTarget(cov, lines, month, anchor), 1066);
  check('nothing granted ahead for 17/10 → 17/11', q.grantedTarget(cov, lines, q.quotaMonthOf(at(2026, 10, 18), anchor), anchor), 0);
}
{
  // bought 30/08 with the billing boundary 05/09: one quota month, not split across two
  const anchor = at(2026, 8, 5);
  const lines = [line('in_2', at(2026, 8, 30), 387, at(2026, 8, 30), at(2026, 9, 5))];
  const cov = q.coverageFromLines(lines);
  check('30/08 → 05/09 inside 05/08 → 05/09: floor(2,000 × 6/31) = 387', q.grantedTarget(cov, lines, q.quotaMonthOf(at(2026, 8, 30), anchor), anchor), 387);
  check('05/09 opens a new quota month with nothing granted ahead', q.grantedTarget(cov, lines, q.quotaMonthOf(at(2026, 9, 6), anchor), anchor), 0);
}
{
  // bought at the start of the billing period: a whole month
  const anchor = at(2026, 9, 10);
  const first = [line('in_1', at(2026, 9, 10), 2000, at(2026, 9, 10), at(2026, 10, 10))];
  const next = q.quotaMonthOf(at(2026, 10, 12), anchor);
  check('10/09 → 10/10 is paid in full: 2,000', q.grantedTarget(q.coverageFromLines(first), first, q.quotaMonthOf(at(2026, 9, 12), anchor), anchor), 2000);
  check('the renewal boundary IS the quota boundary: 10/10 → 10/11 is 0 before it is paid, never a partial', q.grantedTarget(q.coverageFromLines(first), first, next, anchor), 0);
  const renewed = [...first, line('in_2', at(2026, 10, 10), 2000, at(2026, 10, 10), at(2026, 11, 10))];
  check('and 2,000 once it is paid', q.grantedTarget(q.coverageFromLines(renewed), renewed, next, anchor), 2000);
}

console.log('\n\x1b[1mYearly base plan from the start: twelve whole quota months\x1b[0m');
{
  const anchor = at(2026, 9, 5);
  const lines = [line('in_y', at(2026, 9, 5), 21600, at(2026, 9, 5), at(2027, 9, 5), true)];
  const cov = q.coverageFromLines(lines);
  const months = q.quotaMonthsTouching({ start: at(2026, 9, 5), end: at(2027, 9, 5) }, anchor);
  const grants = months.map((m) => q.grantedTarget(cov, lines, m, anchor));
  check('twelve quota months on the 5th', months.length, 12);
  check('each one 2,000', grants, Array(12).fill(2000));
  check('the year totals exactly 24,000 with no true-up needed', grants.reduce((a, b) => a + b, 0), 24000);
}

console.log('\n\x1b[1mBase-plan interval change: billing restarts, the quota cycle does not\x1b[0m');
{
  // Monthly on the 15th, X bought 15/09. On 20/09 the base plan goes yearly with
  // billing_cycle_anchor=now: billing now runs 20/09 → 20/09, the quota keeps the 15th.
  const anchor = at(2026, 9, 15);
  const lines = [
    line('in_m', at(2026, 9, 15), 2000, at(2026, 9, 15), at(2026, 10, 15)),
    line('in_s', at(2026, 9, 20), -1667, at(2026, 9, 20), at(2026, 10, 15)),
    line('in_s', at(2026, 9, 20), 21600, at(2026, 9, 20), at(2027, 9, 20), true),
  ];
  const cov = q.coverageFromLines(lines);
  check('one continuous coverage range', cov, [{ start: at(2026, 9, 15), end: at(2027, 9, 20) }]);
  check('the quota month in progress stays 15/09 → 15/10, not 20/09 → 20/10', q.quotaMonthOf(at(2026, 9, 25), anchor), { start: at(2026, 9, 15), end: at(2026, 10, 15) });
  check('and is granted once: 2,000, not 2,000 + the yearly share', q.grantedTarget(cov, lines, q.quotaMonthOf(at(2026, 9, 25), anchor), anchor), 2000);
  check('quota months keep the 15th under yearly billing: 15/10 → 15/11 = 2,000', q.grantedTarget(cov, lines, q.quotaMonthOf(at(2026, 10, 16), anchor), anchor), 2000);
  // the paid year ends on 20/09/2027, inside the quota month 15/09 → 15/10/2027:
  // floor(25/30 × 2,000) + 11 × 2,000 + floor(5/30 × 2,000) = 1,666 + 22,000 + 333 = 23,999
  check('the quota month the year ends in: 333 + the 1-post true-up = 334', q.grantedTarget(cov, lines, q.quotaMonthOf(at(2027, 9, 16), anchor), anchor), 334);
}

console.log('\n\x1b[1mCycles apart: true-up and cancellation\x1b[0m');
{
  // quota anchored on the 1st, a yearly X line billed from 05/09 — the shape an
  // interval change leaves behind when the quota cycle started on the 1st
  const anchor = at(2026, 9, 1);
  const lines = [line('in_y', at(2026, 9, 5), 21600, at(2026, 9, 5), at(2027, 9, 5), true)];
  const cov = q.coverageFromLines(lines);
  const months = q.quotaMonthsTouching({ start: at(2026, 9, 5), end: at(2027, 9, 5) }, anchor);
  const grants = months.map((m) => q.grantedTarget(cov, lines, m, anchor));
  check('first quota month 05/09 → 01/10 = 1,733', grants[0], 1733);
  check('11 full quota months = 22,000', grants.slice(1, 12).reduce((a, b) => a + b, 0), 22000);
  check('last quota month 01/09 → 05/09 = 267 (266 + true-up)', grants[12], 267);
  check('the year totals exactly 24,000', grants.reduce((a, b) => a + b, 0), 24000);

  const renewed = [...lines, line('in_y2', at(2027, 9, 5), 21600, at(2027, 9, 5), at(2028, 9, 5), true)];
  check('renewal mid-quota-month: 267 + 1,733 = 2,000, never above', q.grantedTarget(q.coverageFromLines(renewed), renewed, q.quotaMonthOf(at(2027, 9, 10), anchor), anchor), 2000);

  const cut = [...lines, line('in_c', at(2026, 9, 20), -18000, at(2026, 10, 1), at(2027, 9, 5), true)];
  const covCut = q.coverageFromLines(cut);
  check('yearly cancel keeps the quota month in progress (1,733)', q.grantedTarget(covCut, cut, q.quotaMonthOf(at(2026, 9, 20), anchor), anchor), 1733);
  check('and grants nothing after quotaMonthEnd', q.grantedTarget(covCut, cut, q.quotaMonthOf(at(2026, 10, 2), anchor), anchor), 0);
  check('coverage ends at quotaMonthEnd', q.coverageEnd(covCut), at(2026, 10, 1));

  const resumed = [...cut, line('in_r', at(2026, 9, 25), 18000, at(2026, 10, 1), at(2027, 9, 5), true)];
  check('after buying X again the last quota month gets its true-up again', q.grantedTarget(q.coverageFromLines(resumed), resumed, q.quotaMonthOf(at(2027, 9, 1), anchor), anchor), 267);
}
{
  // quota on the 1st, billing on the 10th: a renewal inside the quota month adds only the missing delta
  const anchor = at(2026, 9, 1);
  const first = [line('in_1', at(2026, 9, 10), 2000, at(2026, 9, 10), at(2026, 10, 10))];
  const oct = q.quotaMonthOf(at(2026, 10, 2), anchor);
  check('01/10 → 01/11 before the renewal: 9 of 31 days paid = 580', q.grantedTarget(q.coverageFromLines(first), first, oct, anchor), 580);
  const renewed = [...first, line('in_2', at(2026, 10, 10), 2000, at(2026, 10, 10), at(2026, 11, 10))];
  const { target, delta } = q.projectedDelta(q.coverageFromLines(renewed), renewed, oct, null, 580, anchor);
  check('after the renewal is paid: 2,000, i.e. +1,420', [target, delta], [2000, 1420]);
}

console.log('\n\x1b[1mReplay order (idempotent reconcile)\x1b[0m');
{
  // cancel and buy-again in the same simulated second: the invoice number orders them
  const t = at(2026, 9, 20);
  const lines = [
    line('in_y', at(2026, 9, 5), 21600, at(2026, 9, 5), at(2027, 9, 5), true),
    line('in_cancel', t, -18000, at(2026, 10, 1), at(2027, 9, 5), true),
    line('in_resume', t, 18000, at(2026, 10, 1), at(2027, 9, 5), true),
  ];
  check('cancel then buy-again in the same second leaves the year whole', q.coverageFromLines(lines), [{ start: at(2026, 9, 5), end: at(2027, 9, 5) }]);
  check('replaying twice gives the same answer', q.coverageFromLines([...lines].reverse()), [{ start: at(2026, 9, 5), end: at(2027, 9, 5) }]);
}

console.log(failures === 0 ? '\n\x1b[32mAll quota checks passed.\x1b[0m' : `\n\x1b[31m${failures} quota check(s) failed.\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
