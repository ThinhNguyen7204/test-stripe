import { useState } from 'react';
import { api, day } from '../api';

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'ok',
  TRIALING: 'ok',
  PAYMENT_PENDING: 'warn',
  FROZEN: 'warn',
  CANCELED: 'warn',
  ENDED: 'warn',
  NONE: '',
};

/**
 * The X add-on as MODEL V6 has it: one add-on per tenant, a SCIO quota ledger
 * on a quota month stepped from the billing anchor at first purchase, granted
 * by paid time. The sync-run box is a
 * stand-in for the provider — it spends what X "returned and billed", the way
 * the time machine stands in for the calendar.
 */
export default function XAddonPanel({ accountId, state, run, busy }: any) {
  const [kind, setKind] = useState('manual');
  const [requested, setRequested] = useState('50');
  const [returned, setReturned] = useState('12');
  const [lastRun, setLastRun] = useState<any>(null);
  const x = state?.xAddon;
  if (!x) return null;

  const ledger = x.status === 'TRIALING' ? x.trial : x.ledger;
  const granted = ledger?.granted ?? 0;
  const used = ledger?.used ?? 0;
  const pct = granted ? Math.min(100, Math.round((used / granted) * 100)) : 0;

  const syncRun = () =>
    run(async () => {
      const result = await api.xSyncRun(accountId, {
        kind,
        requested: Number(requested) || 0,
        returned: Number(returned) || 0,
      });
      setLastRun(result.run);
      return result;
    }, `${kind} sync recorded`);

  return (
    <section className="card">
      <h2>X add-on</h2>
      <p className="row wrap">
        <span className={`pill ${STATUS_TONE[x.status] ?? ''}`}>{x.status}</span>
        {x.fanOut ? <span className="tag">fan-out on</span> : <span className="tag">fan-out off</span>}
        {x.manualOnly && <span className="tag">manual only</span>}
      </p>

      {ledger && (
        <>
          <p className="clock">
            {used.toLocaleString()} / {granted.toLocaleString()}
          </p>
          <div className="meter">
            <div className="meter-fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="hint">
            {x.status === 'TRIALING'
              ? `Trial ledger · ${ledger.remaining} left · ends ${day(x.trial.endsAt)}`
              : `Post Updates · ${Math.max(0, granted - used).toLocaleString()} left of this quota month`}
          </p>
        </>
      )}

      <dl className="facts">
        <div>
          <dt>Quota month</dt>
          <dd>
            {day(x.quotaMonth?.start)} → {day(x.quotaMonth?.end)}
          </dd>
        </div>
        {x.ledger && (
          <div>
            <dt>Granted</dt>
            <dd>
              {x.ledger.granted.toLocaleString()} of {x.ledger.fullMonthTarget.toLocaleString()}
              {x.ledger.partial ? ' · by paid time' : ''}
            </dd>
          </div>
        )}
        <div>
          <dt>Stripe paid through</dt>
          <dd>{day(x.paidThrough)}</dd>
        </div>
        {x.frozen && (
          <div>
            <dt>Frozen until</dt>
            <dd>{day(x.frozen.until)}</dd>
          </div>
        )}
        {x.parkedItem && (
          <div>
            <dt>Stripe item</dt>
            <dd title="Cancel keeps the same item at quantity 0 so buying X again does not charge twice (MODEL V6 rows 49, 59)">
              quantity 0 until {day(x.parkedItem.alreadyPaidUntil)} · then cleaned up
              {x.parkedItem.cleanupError ? ` · retrying: ${x.parkedItem.cleanupError}` : ''}
            </dd>
          </div>
        )}
        <div>
          <dt>Capacity</dt>
          <dd>
            {x.capacity.committed.toLocaleString()} + {x.capacity.pending.toLocaleString()} of{' '}
            {x.capacity.ceiling.toLocaleString()}
          </dd>
        </div>
      </dl>

      {(x.ledger?.grants ?? []).length > 0 && (
        <p className="hint">
          Grants this month:{' '}
          {x.ledger.grants.map((g: any) => `+${g.delta} (${day(g.at)})`).join(' · ')}
        </p>
      )}

      {(x.warnings ?? []).length > 0 && (
        <ul className="hint list">
          {x.warnings.map((w: string, i: number) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {x.quantityAlert && <p className="error-text">Alert: {x.quantityAlert}</p>}

      <div className="row wrap top-gap">
        {(x.status === 'ACTIVE' || x.status === 'PAYMENT_PENDING') && (
          <button
            className="ghost small danger"
            disabled={busy}
            onClick={() => run(() => api.xCancel(accountId), 'X add-on cancelled — frozen until quota month end')}
          >
            Cancel X
          </button>
        )}
        {x.repurchase && (
          <button
            className="ghost small"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  api.change(accountId, {
                    planCode: state.current.planCode,
                    term: state.current.term,
                    screens: state.current.screens,
                    addOns: [...(state.current.addOns ?? []), { code: 'x_social', quantity: 1 }],
                  }),
                'X bought again',
              )
            }
            title={
              x.repurchase.kind === 'restores_frozen_remaining'
                ? 'Same item 0 → 1; restores FrozenRemaining until quota month end'
                : 'New activation — the old quota expired'
            }
          >
            Buy X again {x.repurchase.kind === 'restores_frozen_remaining' ? '(restores frozen quota)' : '(new activation)'}
          </button>
        )}
        {x.trialAvailable && (
          <button className="ghost small" disabled={busy} onClick={() => run(() => api.xTrial(accountId), 'X trial started')}>
            Start 14-day trial
          </button>
        )}
      </div>
      {x.repurchase && (
        <p className="hint">
          {x.repurchase.kind === 'restores_frozen_remaining'
            ? `There is no separate restore. Buying X again before ${day(x.repurchase.alreadyPaidUntil)} puts the same item back from quantity 0 to 1 and restores the frozen Remaining, which still expires on ${day(x.quotaMonth?.end)}. `
            : `AlreadyPaidUntil (${day(x.repurchase.alreadyPaidUntil)}) has passed — buying X again is a new activation${x.repurchase.reusesItemId ? ' on the same quantity-0 item' : ' on a new item'}. `}
          {x.repurchase.prorationBehavior === 'none'
            ? 'Nothing is charged now: this time is already paid.'
            : `Stripe charges from ${day(x.repurchase.chargesFrom)} to ${day(x.repurchase.chargesTo)}.`}
        </p>
      )}

      {(x.status === 'ACTIVE' || x.status === 'TRIALING') && (
        <div className="field top-gap">
          <label>Provider fetch (stand-in for X)</label>
          <div className="row wrap">
            <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={busy}>
              <option value="initial" disabled={x.manualOnly}>
                Initial Sync
              </option>
              <option value="auto" disabled={x.manualOnly}>
                Auto Sync
              </option>
              <option value="manual">Manual Refresh</option>
            </select>
            <input type="number" min={0} value={requested} onChange={(e) => setRequested(e.target.value)} title="limit asked" />
            <span className="plan-note">asked</span>
            <input type="number" min={0} value={returned} onChange={(e) => setReturned(e.target.value)} title="Posts returned and billed" />
            <span className="plan-note">returned</span>
            <button className="ghost small" disabled={busy || !x.canFetchNewPosts} onClick={syncRun}>
              Run
            </button>
          </div>
          <p className="hint">
            Quota falls by what X returned and billed, clamped to what is left — not by the limit asked.
            {lastRun && ` Last run: −${lastRun.charged}${lastRun.clamped ? ' (clamped)' : ''}, ${lastRun.remaining} left.`}
          </p>
        </div>
      )}
    </section>
  );
}
