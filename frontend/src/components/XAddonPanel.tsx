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
 * on a fixed calendar quota month, granted by paid time. The sync-run box is a
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
        {x.resume && (
          <button
            className="ghost small"
            disabled={busy}
            onClick={() => run(() => api.xResume(accountId), 'X add-on resumed')}
            title={x.resume.kind === 'same_quota_month' ? 'Reopens the same ledger' : 'New activation — the old quota expired'}
          >
            Resume X {x.resume.kind === 'same_quota_month' ? '(same quota month)' : '(new activation)'}
          </button>
        )}
        {x.trialAvailable && (
          <button className="ghost small" disabled={busy} onClick={() => run(() => api.xTrial(accountId), 'X trial started')}>
            Start 14-day trial
          </button>
        )}
      </div>
      {x.resume && (
        <p className="hint">
          {x.resume.prorationBehavior === 'none'
            ? 'Resume charges nothing now — this time is already paid.'
            : `Resume charges from ${day(x.resume.chargesFrom)} to ${day(x.resume.chargesTo)}.`}
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
