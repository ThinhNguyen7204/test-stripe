/**
 * The X add-on's quota arithmetic, MODEL V6 — pure functions, no I/O.
 *
 * Two clocks run side by side and never reset each other (V6 row 6):
 *
 *  - Stripe owns money and billing time. What it has been PAID for is a set of
 *    time ranges: the periods on the X lines of paid invoices.
 *  - SCIO owns the quota month, fixed to the calendar in UTC
 *    ([1st 00:00, 1st of next month 00:00)), whatever day Stripe bills on
 *    (row 46).
 *
 * A quota month's target is the share of it that is paid for:
 * `floor(2,000 × paidCoveredSeconds / monthSeconds)` (rows 5 and 47). Paid
 * coverage is a UNION, so a stretch of time that is paid twice — once on the
 * monthly price and again after a switch to yearly — counts once (rows 6, 60).
 */

export const X_ADDON_CODE = 'x_social';
/** a fully paid quota month (row 4) */
export const X_MONTHLY_TARGET = 2000;
/** a fully paid year of continuous annual coverage (rows 52, 63) */
export const X_ANNUAL_TOTAL = 24000;
/** row 50 */
export const X_TRIAL_DAYS = 14;
export const X_TRIAL_POSTS = 200;
/** row 17: every tenant admitted holds one reservation of a full month's target */
export const X_RESERVATION_UNITS = 2000;
export const X_RESERVATION_TTL_SECONDS = 15 * 60;
/** row 17 */
export const X_COMMERCIAL_CEILING = 2_500_000;
export const X_PROVIDER_HARD_CAP = 3_000_000;

const DAY = 86400;
/** a line at least this long is a whole annual term, not a slice of one */
const FULL_YEAR_SECONDS = 365 * DAY;

/** A half-open time range [start, end), unix seconds. */
export interface Interval {
  start: number;
  end: number;
}

/** The SCIO quota month that contains `t` (row 46). */
export function quotaMonthOf(t: number): Interval {
  const d = new Date(t * 1000);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  return { start, end };
}

export function nextQuotaMonth(q: Interval): Interval {
  return quotaMonthOf(q.end);
}

/** Sorted, merged, empty ranges dropped. */
export function union(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .map((i) => ({ ...i }))
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push(i);
  }
  return out;
}

export function subtract(intervals: Interval[], cut: Interval): Interval[] {
  const out: Interval[] = [];
  for (const i of intervals) {
    if (cut.end <= i.start || cut.start >= i.end) {
      out.push(i);
      continue;
    }
    if (cut.start > i.start) out.push({ start: i.start, end: cut.start });
    if (cut.end < i.end) out.push({ start: cut.end, end: i.end });
  }
  return union(out);
}

/** Seconds of `intervals` that fall inside `window`. */
export function overlap(intervals: Interval[], window: Interval): number {
  let total = 0;
  for (const i of intervals) {
    const s = Math.max(i.start, window.start);
    const e = Math.min(i.end, window.end);
    if (e > s) total += e - s;
  }
  return total;
}

export function contains(intervals: Interval[], range: Interval): boolean {
  return overlap(union(intervals), range) >= range.end - range.start;
}

/** The covered range `t` sits in, if any. */
export function coveringInterval(intervals: Interval[], t: number): Interval | null {
  return union(intervals).find((i) => i.start <= t && t < i.end) ?? null;
}

/** How far the paid coverage reaches at all — where a re-added item has to start charging. */
export function coverageEnd(intervals: Interval[]): number | null {
  const merged = union(intervals);
  return merged.length ? merged[merged.length - 1].end : null;
}

/**
 * One X line on a paid invoice. Positive lines BUY a range; negative ones are
 * Stripe crediting a range back (a yearly cancellation from quotaMonthEnd, the
 * unused part of a monthly price replaced by a yearly one).
 */
export interface XInvoiceLine {
  invoiceId: string;
  /** when the invoice was created, in the customer's (possibly simulated) time */
  created: number;
  /** trailing number of the invoice, to order invoices created in the same second */
  sequence: number;
  amount: number;
  start: number;
  end: number;
  yearly: boolean;
}

/**
 * Paid coverage, replayed from the paid invoices in the order Stripe raised
 * them. Within one invoice the credits are applied before the purchases, which
 * is what one invoice means: "this range is no longer paid on the old terms,
 * and this range now is".
 *
 * Replaying rather than accumulating is what makes this idempotent: a webhook
 * delivered twice, or a reconcile that runs on every read, always lands on the
 * same answer, and a payment that fails never adds a range at all (row 51).
 */
export function coverageFromLines(lines: XInvoiceLine[]): Interval[] {
  const byInvoice = new Map<string, XInvoiceLine[]>();
  for (const line of lines) {
    const list = byInvoice.get(line.invoiceId) ?? [];
    list.push(line);
    byInvoice.set(line.invoiceId, list);
  }
  const invoices = [...byInvoice.values()].sort(
    (a, b) => a[0].created - b[0].created || a[0].sequence - b[0].sequence || a[0].invoiceId.localeCompare(b[0].invoiceId),
  );

  let coverage: Interval[] = [];
  for (const invoiceLines of invoices) {
    for (const line of invoiceLines.filter((l) => l.amount < 0)) {
      coverage = subtract(coverage, { start: line.start, end: line.end });
    }
    coverage = union([
      ...coverage,
      ...invoiceLines.filter((l) => l.amount >= 0).map((l) => ({ start: l.start, end: l.end })),
    ]);
  }
  return coverage;
}

/** `floor(2,000 × covered / month)` for one quota month, before any annual true-up. */
export function proportionalTarget(coverage: Interval[], q: Interval): number {
  const span = q.end - q.start;
  if (span <= 0) return 0;
  return Math.floor((X_MONTHLY_TARGET * overlap(coverage, q)) / span);
}

/** Every quota month a range touches, in order. */
export function quotaMonthsTouching(range: Interval): Interval[] {
  const months: Interval[] = [];
  let q = quotaMonthOf(range.start);
  while (q.start < range.end) {
    months.push(q);
    q = nextQuotaMonth(q);
  }
  return months;
}

/**
 * Row 63's true-up. Flooring each segment of a year separately can come out
 * short of 24,000 (1,733 + 11 × 2,000 + 266 = 23,999), so the quota month in
 * which a whole paid year ends receives the difference. It only ever fixes a
 * rounding shortfall: it never exceeds what flooring lost, and it applies only
 * to a year that is still paid in full — a year cut short by a cancellation is
 * not owed 24,000.
 */
export function annualTrueUp(coverage: Interval[], lines: XInvoiceLine[], q: Interval): number {
  let trueUp = 0;
  for (const line of lines) {
    if (!line.yearly || line.amount < 0) continue;
    const year = { start: line.start, end: line.end };
    if (year.end - year.start < FULL_YEAR_SECONDS) continue;
    if (!(year.end > q.start && year.end <= q.end)) continue;
    if (!contains(coverage, year)) continue;
    const floored = quotaMonthsTouching(year).reduce((sum, m) => sum + proportionalTarget([year], m), 0);
    trueUp += Math.max(0, X_ANNUAL_TOTAL - floored);
  }
  return trueUp;
}

/**
 * GrantedTarget of a quota month (row 5): the paid share of the month, plus the
 * annual true-up when a paid year ends inside it, never above a whole month's
 * 2,000.
 */
export function grantedTarget(coverage: Interval[], lines: XInvoiceLine[], q: Interval): number {
  return Math.min(X_MONTHLY_TARGET, proportionalTarget(coverage, q) + annualTrueUp(coverage, lines, q));
}

/** What an extra paid range would add to a quota month, for previews. */
export function projectedDelta(
  coverage: Interval[],
  lines: XInvoiceLine[],
  q: Interval,
  added: Interval | null,
  alreadyGranted: number,
): { target: number; delta: number } {
  const next = added ? union([...coverage, added]) : coverage;
  const target = Math.max(alreadyGranted, grantedTarget(next, lines, q));
  return { target, delta: target - alreadyGranted };
}
