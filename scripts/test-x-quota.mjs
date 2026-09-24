#!/usr/bin/env node
/**
 * The X add-on's quota arithmetic against the worked examples in MODEL V6.
 * Pure functions, no Stripe and no Mongo — build the backend first:
 *
 *   (cd backend && npm run build) && node scripts/test-x-quota.mjs
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

console.log('\n\x1b[1mQuota month (row 46)\x1b[0m');
check('fixed to the calendar in UTC', q.quotaMonthOf(at(2026, 9, 15) + 3600), { start: at(2026, 9, 1), end: at(2026, 10, 1) });
check('December rolls into January', q.quotaMonthOf(at(2026, 12, 31)), { start: at(2026, 12, 1), end: at(2027, 1, 1) });

console.log('\n\x1b[1mFirst purchase mid-month (row 47, CASE 1)\x1b[0m');
{
  const lines = [line('in_1', at(2026, 9, 15), 1067, at(2026, 9, 15), at(2026, 10, 1))];
  const cov = q.coverageFromLines(lines);
  check('15/09 → 01/10: floor(2,000 × 16/30) = 1,066', q.grantedTarget(cov, lines, q.quotaMonthOf(at(2026, 9, 15))), 1066);
  check('nothing granted ahead for October', q.grantedTarget(cov, lines, q.quotaMonthOf(at(2026, 10, 2))), 0);
}

console.log('\n\x1b[1mAnnual quota months and the true-up (rows 52, 63, CASE 10)\x1b[0m');
{
  const lines = [line('in_y', at(2026, 9, 5), 21600, at(2026, 9, 5), at(2027, 9, 5), true)];
  const cov = q.coverageFromLines(lines);
  const months = q.quotaMonthsTouching({ start: at(2026, 9, 5), end: at(2027, 9, 5) });
  const grants = months.map((m) => q.grantedTarget(cov, lines, m));
  check('first quota month 05/09 → 01/10 = 1,733', grants[0], 1733);
  check('11 full quota months = 22,000', grants.slice(1, 12).reduce((a, b) => a + b, 0), 22000);
  check('last quota month 01/09 → 05/09 = 267 (266 + true-up)', grants[12], 267);
  check('the year totals exactly 24,000', grants.reduce((a, b) => a + b, 0), 24000);

  // row 66: the yearly renewal on 05/09/2027 adds 1,733 to the same ledger
  const renewed = [...lines, line('in_y2', at(2027, 9, 5), 21600, at(2027, 9, 5), at(2028, 9, 5), true)];
  const cov2 = q.coverageFromLines(renewed);
  check('renewal mid-month: 267 + 1,733 = 2,000, never above', q.grantedTarget(cov2, renewed, q.quotaMonthOf(at(2027, 9, 10))), 2000);

  // a year cut short by a cancellation is not owed 24,000
  const cut = [...lines, line('in_c', at(2026, 9, 20), -18000, at(2026, 10, 1), at(2027, 9, 5), true)];
  const covCut = q.coverageFromLines(cut);
  check('yearly cancel keeps the month in progress (1,733)', q.grantedTarget(covCut, cut, q.quotaMonthOf(at(2026, 9, 20))), 1733);
  check('and grants nothing after quotaMonthEnd', q.grantedTarget(covCut, cut, q.quotaMonthOf(at(2026, 10, 2))), 0);
  check('coverage ends at quotaMonthEnd', q.coverageEnd(covCut), at(2026, 10, 1));

  // resume debits the same boundary back: the year is whole again
  const resumed = [...cut, line('in_r', at(2026, 9, 25), 18000, at(2026, 10, 1), at(2027, 9, 5), true)];
  const covRes = q.coverageFromLines(resumed);
  check('after resume the last month gets its true-up again', q.grantedTarget(covRes, resumed, q.quotaMonthOf(at(2027, 9, 1))), 267);
}

console.log('\n\x1b[1mInterval change never double-grants (rows 6, 60, CASE 9)\x1b[0m');
{
  const lines = [
    line('in_m', at(2026, 9, 15), 2000, at(2026, 9, 15), at(2026, 10, 15)),
    // monthly → yearly on 20/09: Stripe credits the unused monthly time and bills a new year
    line('in_s', at(2026, 9, 20), -1667, at(2026, 9, 20), at(2026, 10, 15)),
    line('in_s', at(2026, 9, 20), 21600, at(2026, 9, 20), at(2027, 9, 20), true),
  ];
  const cov = q.coverageFromLines(lines);
  check('15/09 → 01/10 still grants 1,066 — not 1,066 + 733', q.grantedTarget(cov, lines, q.quotaMonthOf(at(2026, 9, 21))), 1066);
  check('one continuous coverage range', cov, [{ start: at(2026, 9, 15), end: at(2027, 9, 20) }]);
}

console.log('\n\x1b[1mRenewal adds the missing delta only (rows 46, 66)\x1b[0m');
{
  const first = [line('in_1', at(2026, 9, 10), 2000, at(2026, 9, 10), at(2026, 10, 10))];
  const oct = q.quotaMonthOf(at(2026, 10, 2));
  check('October before the renewal: 9 of 31 days paid = 580', q.grantedTarget(q.coverageFromLines(first), first, oct), 580);
  const renewed = [...first, line('in_2', at(2026, 10, 10), 2000, at(2026, 10, 10), at(2026, 11, 10))];
  const { target, delta } = q.projectedDelta(q.coverageFromLines(renewed), renewed, oct, null, 580);
  check('after the renewal is paid: 2,000, i.e. +1,420', [target, delta], [2000, 1420]);
}

console.log('\n\x1b[1mReplay order (idempotent reconcile)\x1b[0m');
{
  // cancel and resume in the same simulated second: the invoice number orders them
  const t = at(2026, 9, 20);
  const lines = [
    line('in_y', at(2026, 9, 5), 21600, at(2026, 9, 5), at(2027, 9, 5), true),
    line('in_cancel', t, -18000, at(2026, 10, 1), at(2027, 9, 5), true),
    line('in_resume', t, 18000, at(2026, 10, 1), at(2027, 9, 5), true),
  ];
  check('cancel then resume in the same second leaves the year whole', q.coverageFromLines(lines), [{ start: at(2026, 9, 5), end: at(2027, 9, 5) }]);
  check('replaying twice gives the same answer', q.coverageFromLines([...lines].reverse()), [{ start: at(2026, 9, 5), end: at(2027, 9, 5) }]);
}

console.log(failures === 0 ? '\n\x1b[32mAll quota checks passed.\x1b[0m' : `\n\x1b[31m${failures} quota check(s) failed.\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
