import { useEffect, useMemo, useState } from 'react';
import { api, day, money } from '../api';

export default function SubscriptionPanel({ accountId, catalog, state, run, busy }: any) {
  const [draft, setDraft] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [overrides, setOverrides] = useState<any>({});
  // null = follow the billing policy, true/false = the operator decided
  const [trialChoice, setTrialChoice] = useState<boolean | null>(null);
  const currency = catalog?.currency ?? 'usd';

  // Reset the draft whenever the live subscription changes.
  useEffect(() => {
    if (!state?.current) return;
    setDraft({
      planCode: state.current.planCode,
      term: state.current.term,
      screens: state.current.screens,
      addOns: Object.fromEntries(state.current.addOns.map((a: any) => [a.code, a.quantity])),
    });
    setPreview(null);
    setPreviewError(null);
  }, [state?.current?.planCode, state?.current?.term, state?.current?.screens, JSON.stringify(state?.current?.addOns)]);

  const desired = useMemo(() => {
    if (!draft) return null;
    return {
      planCode: draft.planCode,
      term: draft.term,
      screens: Number(draft.screens) || 0,
      addOns: Object.entries(draft.addOns ?? {})
        .filter(([, q]: any) => Number(q) > 0)
        .map(([code, quantity]: any) => ({ code, quantity: Number(quantity) })),
      overrides: Object.keys(overrides).length ? overrides : undefined,
      ...(trialChoice === null ? {} : { withTrial: trialChoice }),
    };
  }, [draft, overrides, trialChoice]);

  const dirty = useMemo(() => {
    if (!desired || !state?.current) return false;
    const a = JSON.stringify({ ...desired, overrides: undefined, withTrial: undefined });
    const b = JSON.stringify({
      planCode: state.current.planCode,
      term: state.current.term,
      screens: state.current.screens,
      addOns: state.current.addOns,
    });
    return a !== b;
  }, [desired, state]);

  // Ask Stripe for the exact invoice this change would create.
  useEffect(() => {
    if (!desired || !accountId) return;
    if (!dirty && state?.stripe) {
      setPreview(null);
      return;
    }
    const handle = setTimeout(async () => {
      setPreviewing(true);
      setPreviewError(null);
      try {
        setPreview(await api.preview(accountId, desired));
      } catch (err: any) {
        setPreview(null);
        setPreviewError(err.message);
      } finally {
        setPreviewing(false);
      }
    }, 450);
    return () => clearTimeout(handle);
  }, [JSON.stringify(desired), dirty, accountId]);

  if (!catalog || !draft || !state) return <div className="empty">Loading…</div>;

  // A cancelled subscription still comes back from Stripe, but nothing can be
  // done to it any more — starting a plan again creates a fresh one.
  const LIVE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'];
  const isLive = Boolean(state.stripe && LIVE_STATUSES.includes(state.stripe.status));

  const plans = catalog.plans ?? [];
  const addons = catalog.addons ?? [];
  // the X add-on is a single on/off line with quantity fixed at 1 (MODEL V6 row 4)
  const xAddon = addons.find((a: any) => a.code === 'x_social');
  const perUnitAddons = addons.filter((a: any) => a.code !== 'x_social');
  const xOn = Number(draft.addOns?.x_social ?? 0) > 0;
  const xStatus = state.xAddon?.status ?? 'NONE';
  const activePlan = plans.find((p: any) => p.code === draft.planCode);
  const perScreen = draft.term === 'yearly' ? activePlan?.annualMonthlyCents : activePlan?.monthlyCents;

  const monthlyTotal =
    (perScreen ?? 0) * (Number(draft.screens) || 0) +
    addons.reduce((sum: number, addon: any) => {
      const qty = Number(draft.addOns?.[addon.code] ?? 0);
      const unit = draft.term === 'yearly' ? addon.annualMonthlyCents : addon.monthlyCents;
      return sum + unit * qty;
    }, 0);

  return (
    <div className="grid-2">
      <section className="card">
        <h2>Configure the subscription</h2>

        <div className="field">
          <label>Billing term</label>
          <div className="segmented">
            {['monthly', 'yearly'].map((term) => (
              <button
                key={term}
                className={draft.term === term ? 'seg active' : 'seg'}
                onClick={() => setDraft({ ...draft, term })}
              >
                {term === 'monthly' ? 'Monthly' : `Yearly (−${catalog.annualDiscountPercent}%)`}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Plan</label>
          <div className="plan-list">
            {plans.map((plan: any) => {
              const unit = draft.term === 'yearly' ? plan.annualMonthlyCents : plan.monthlyCents;
              return (
                <button
                  key={plan.code}
                  className={draft.planCode === plan.code ? 'plan selected' : 'plan'}
                  onClick={() => {
                    // keep the draft legal for the plan just picked: Free caps at 3
                    // screens and takes no add-ons, Enterprise needs at least 25.
                    const min = plan.minQuantity ?? 0;
                    const max = plan.maxQuantity ?? Number.MAX_SAFE_INTEGER;
                    const screens = Math.min(Math.max(Number(draft.screens) || 0, min), max);
                    setDraft({
                      ...draft,
                      planCode: plan.code,
                      screens,
                      addOns: plan.code === 'free' ? {} : draft.addOns,
                    });
                  }}
                >
                  <div className="plan-head">
                    <strong>{plan.name}</strong>
                    <span>{unit === 0 ? 'Free' : `${money(unit, currency)} / screen / mo`}</span>
                  </div>
                  <span className="plan-note">
                    {plan.minQuantity > 1 ? `min ${plan.minQuantity} screens · ` : ''}
                    {plan.features.slice(0, 2).join(' · ')}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="field">
          <label>Screens</label>
          <div className="stepper">
            <button onClick={() => setDraft({ ...draft, screens: Math.max(0, Number(draft.screens) - 1) })}>−</button>
            <input
              type="number"
              min={0}
              value={draft.screens}
              onChange={(e) => setDraft({ ...draft, screens: Math.max(0, Number(e.target.value)) })}
            />
            <button onClick={() => setDraft({ ...draft, screens: Number(draft.screens) + 1 })}>+</button>
          </div>
        </div>

        {xAddon && (
          <div className="field">
            <label>X Social add-on</label>
            <div className="segmented">
              {[false, true].map((on) => (
                <button
                  key={String(on)}
                  className={xOn === on ? 'seg active' : 'seg'}
                  onClick={() => {
                    const next = { ...(draft.addOns ?? {}) };
                    if (on) next.x_social = 1;
                    else delete next.x_social;
                    setDraft({ ...draft, addOns: next });
                  }}
                >
                  {on ? 'On' : 'Off'}
                </button>
              ))}
            </div>
            <div className="plan-note">
              {money(xAddon.monthlyCents, currency)} / month or {money(xAddon.annualMonthlyCents * 12, currency)} / year ·
              one per account, quantity fixed at 1 · 2,000 Post Updates per quota month, granted by paid time
            </div>
            {(xStatus === 'FROZEN' || xStatus === 'CANCELED') && (
              <p className="hint">
                {xStatus === 'FROZEN'
                  ? `Cancelled — frozen until ${day(state.xAddon.frozen?.until)}. Turning it on resumes the same quota month.`
                  : 'Cancelled and its quota month is over — turning it on is a new activation.'}
              </p>
            )}
            <p className="hint">Add or cancel it on its own: it has its own proration boundary and paid gate.</p>
          </div>
        )}

        <div className="field">
          <label>Per-unit add-ons</label>
          {perUnitAddons.map((addon: any) => {
            const unit = draft.term === 'yearly' ? addon.annualMonthlyCents : addon.monthlyCents;
            const qty = Number(draft.addOns?.[addon.code] ?? 0);
            return (
              <div key={addon.code} className="addon">
                <div>
                  <strong>{addon.name}</strong>
                  <span className="plan-note">
                    {money(unit, currency)} / {addon.unitLabel} / mo
                    {addon.boundToScreens ? ' · max = screen count' : ''}
                  </span>
                </div>
                <div className="stepper small">
                  <button
                    onClick={() =>
                      setDraft({ ...draft, addOns: { ...draft.addOns, [addon.code]: Math.max(0, qty - 1) } })
                    }
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min={0}
                    value={qty}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        addOns: { ...draft.addOns, [addon.code]: Math.max(0, Number(e.target.value)) },
                      })
                    }
                  />
                  <button
                    onClick={() => setDraft({ ...draft, addOns: { ...draft.addOns, [addon.code]: qty + 1 } })}
                  >
                    +
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="total">
          <span>Contract value</span>
          <strong>
            {money(monthlyTotal, currency)} / month
            {draft.term === 'yearly' ? ` · ${money(monthlyTotal * 12, currency)} billed yearly` : ''}
          </strong>
        </div>

        {!isLive && (
          <div className="field trial-box">
            <label>Trial</label>
            <label className="check">
              <input
                type="checkbox"
                checked={trialChoice ?? preview?.trial?.willApply ?? false}
                onChange={(e) => setTrialChoice(e.target.checked)}
              />
              Start this subscription with a trial
              {trialChoice === null && <span className="tag">following policy</span>}
            </label>
            <p className="hint">
              {preview?.trial?.error
                ? preview.trial.error
                : preview?.trial
                  ? `${preview.trial.willApply ? `${preview.trial.days}-day trial` : 'No trial'} — ${preview.trial.reason}`
                  : 'The billing policy decides unless you tick the box.'}
            </p>
            {trialChoice !== null && (
              <button className="ghost small" onClick={() => setTrialChoice(null)}>
                back to policy default
              </button>
            )}
          </div>
        )}

        <details className="overrides">
          <summary>One-off policy override for this change</summary>
          <p className="hint">
            Leave empty to use the active billing policy. Anything set here applies to this single change only —
            handy for showing two behaviours side by side.
          </p>
          {[
            ['timing', ['', 'immediate', 'end_of_period']],
            ['prorationBehavior', ['', 'create_prorations', 'always_invoice', 'none']],
            ['billingCycleAnchor', ['', 'unchanged', 'now']],
            ['creditHandling', ['', 'customer_balance', 'push_to_account_balance', 'refund_to_payment_method', 'none']],
          ].map(([key, options]: any) => (
            <div className="row" key={key}>
              <label className="mini">{key}</label>
              <select
                value={overrides[key] ?? ''}
                onChange={(e) => {
                  const next = { ...overrides };
                  if (e.target.value) next[key] = e.target.value;
                  else delete next[key];
                  setOverrides(next);
                }}
              >
                {options.map((o: string) => (
                  <option key={o} value={o}>
                    {o || '(use policy)'}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </details>

        <div className="row top-gap">
          <button
            disabled={busy || !dirty}
            onClick={() => run(() => api.change(accountId, desired), 'Change applied through Stripe')}
          >
            {state.stripe ? 'Apply change' : 'Start subscription'}
          </button>
          <button
            className="ghost"
            disabled={!dirty}
            onClick={() =>
              setDraft({
                planCode: state.current.planCode,
                term: state.current.term,
                screens: state.current.screens,
                addOns: Object.fromEntries(state.current.addOns.map((a: any) => [a.code, a.quantity])),
              })
            }
          >
            Reset
          </button>
        </div>
      </section>

      <div className="stack">
        <section className="card">
          <h2>What Stripe will do</h2>
          {previewing && <p className="hint">Asking Stripe for a preview…</p>}
          {previewError && <p className="error-text">{previewError}</p>}
          {!dirty && !previewError && <p className="hint">Change something on the left to see the proration preview.</p>}

          {preview && (
            <>
              <div className="rule-box">
                <span className="pill">{preview.ruleKey ?? preview.mode}</span>
                <ul>
                  {(preview.explanation ?? []).map((line: string, i: number) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>

              {/*
                X capacity is a platform-wide figure, so nothing on this
                account shows how close a purchase is to the ceiling. A refusal
                would otherwise arrive with no warning at all.
              */}
              {preview.capacity && (
                <div className="rule-box">
                  <span className={`pill ${preview.capacity.admitsOneMore ? 'ok' : 'warn'}`}>X capacity</span>
                  <ul>
                    <li>
                      {preview.capacity.committed.toLocaleString()} committed + {preview.capacity.pending.toLocaleString()}{' '}
                      pending of a {preview.capacity.ceiling.toLocaleString()} commercial ceiling (
                      {preview.capacity.hardCap.toLocaleString()} hard cap, {preview.capacity.buffer.toLocaleString()} buffer).
                    </li>
                    {!preview.capacity.admitsOneMore && (
                      <li className="error-text">No room for another 2,000 — this purchase would be refused.</li>
                    )}
                  </ul>
                </div>
              )}

              {preview.quota && (
                <table className="lines">
                  <tbody>
                    <tr>
                      <td>
                        Quota month {day(preview.quota.quotaMonth?.start)} → {day(preview.quota.quotaMonth?.end)}
                        {preview.quota.formula && <div className="period">{preview.quota.formula}</div>}
                      </td>
                      <td className="right">
                        {preview.mode === 'x_cancel'
                          ? `frozen at ${preview.quota.granted} / used ${preview.quota.used}`
                          : `+${preview.quota.delta} → ${preview.quota.target}`}
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}

              {!preview.invoice && preview.previewUnavailable && (
                <p className="hint">{preview.previewUnavailable}</p>
              )}

              {preview.mode === 'schedule' && (
                <p className="hint">
                  Below is <strong>one full billing period at the new configuration</strong>, effective{' '}
                  {day(preview.effectiveAt)}. Stripe prices it against the current period, so the per-line dates are
                  its own reference frame — the amounts are what matters here.
                </p>
              )}

              {preview.invoice && (
                <table className="lines">
                  <thead>
                    <tr>
                      <th>Line</th>
                      <th>Qty</th>
                      <th className="right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.invoice.lines.map((line: any) => (
                      <tr key={line.id} className={line.proration ? 'proration' : ''}>
                        <td>
                          {line.description}
                          {line.proration && <span className="tag">proration</span>}
                          {preview.mode !== 'schedule' && (
                            <div className="period">
                              {day(line.periodStart)} → {day(line.periodEnd)}
                            </div>
                          )}
                        </td>
                        <td>{line.quantity ?? '—'}</td>
                        <td className="right">{money(line.amount, preview.invoice.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {preview.mode !== 'schedule' && (
                      <>
                        <tr>
                          <td colSpan={2}>Prorations</td>
                          <td className="right">{money(preview.invoice.prorationTotal, preview.invoice.currency)}</td>
                        </tr>
                        <tr>
                          <td colSpan={2}>Applied account credit</td>
                          <td className="right">
                            {money(-(preview.invoice.startingBalance ?? 0), preview.invoice.currency)}
                          </td>
                        </tr>
                      </>
                    )}
                    <tr className="grand">
                      <td colSpan={2}>{preview.mode === 'schedule' ? 'Per period from then on' : 'Amount due'}</td>
                      <td className="right">{money(preview.invoice.amountDue, preview.invoice.currency)}</td>
                    </tr>
                  </tfoot>
                </table>
              )}

              <details className="raw">
                <summary>Exact Stripe parameters</summary>
                <pre>{JSON.stringify(preview.stripeParams, null, 2)}</pre>
              </details>
            </>
          )}
        </section>

        {(state.warnings ?? []).length > 0 && (
          <section className="card">
            <h2>Heads-up</h2>
            <ul className="hint list">
              {state.warnings.map((w: string, i: number) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            {state.stripe?.hostedInvoiceUrl && state.stripe?.status === 'incomplete' && (
              <a className="ghost small" href={state.stripe.hostedInvoiceUrl} target="_blank" rel="noreferrer">
                Open hosted invoice to confirm payment
              </a>
            )}
          </section>
        )}

        <section className="card">
          <h2>{isLive ? 'Live subscription' : 'Stripe subscription'}</h2>
          {!state.stripe && <p className="hint">No Stripe subscription yet — the account is on the Free plan.</p>}
          {state.stripe && !isLive && (
            <p className="hint">
              This subscription is <strong>{state.stripe.status}</strong> and can no longer be changed. The account
              is back on the Free plan — picking a paid plan on the left starts a brand new subscription.
            </p>
          )}
          {state.stripe && (
            <>
              <dl className="facts">
                <div>
                  <dt>Subscription</dt>
                  <dd className="mono">{state.stripe.id}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{state.stripe.status}</dd>
                </div>
                <div>
                  <dt>Period</dt>
                  <dd>
                    {day(state.stripe.currentPeriodStart)} → {day(state.stripe.currentPeriodEnd)}
                  </dd>
                </div>
                <div>
                  <dt>Billing mode</dt>
                  <dd>{state.stripe.billingMode ?? '—'}</dd>
                </div>
                {state.stripe.trialEnd && (
                  <div>
                    <dt>Trial ends</dt>
                    <dd>{day(state.stripe.trialEnd)}</dd>
                  </div>
                )}
                {state.stripe.pauseCollection && (
                  <div>
                    <dt>Paused</dt>
                    <dd>{state.stripe.pauseCollection.behavior}</dd>
                  </div>
                )}
              </dl>

              {state.pendingChange && (
                <div className="banner ok inline">
                  <span>
                    Scheduled change ({state.pendingChange.ruleKey}): {state.pendingChange.changes?.join(', ')} —
                    effective {day(state.pendingChange.effectiveAt)}
                  </span>
                  {/*
                    Row 49 gives the customer a way back before the boundary.
                    Re-selecting the add-on cannot do it: the live subscription
                    still holds it, so the request reads as no change at all.
                  */}
                  <button
                    className="ghost small"
                    disabled={busy}
                    onClick={() =>
                      run(() => api.cancelScheduledChange(accountId), 'Scheduled change called off')
                    }
                  >
                    Call it off
                  </button>
                </div>
              )}

              {isLive && (
              <div className="row wrap top-gap">
                {state.account.cancelAtPeriodEnd ? (
                  <button className="ghost small" disabled={busy} onClick={() => run(() => api.resume(accountId), 'Cancellation reverted')}>
                    Undo cancellation
                  </button>
                ) : (
                  <button
                    className="ghost small danger"
                    disabled={busy}
                    onClick={() => run(() => api.cancel(accountId, {}), 'Cancellation processed per policy')}
                  >
                    Cancel (policy default)
                  </button>
                )}
                <button
                  className="ghost small danger"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => api.cancel(accountId, { timing: 'immediate', prorateUnusedTime: true, invoiceImmediately: true }),
                      'Cancelled immediately with proration',
                    )
                  }
                >
                  Cancel now + prorate
                </button>
                {state.stripe.status === 'trialing' && (
                  <button
                    className="ghost small"
                    disabled={busy}
                    onClick={() => run(() => api.endTrial(accountId), 'Trial ended — Stripe billed the first period')}
                  >
                    End trial now
                  </button>
                )}
                {state.stripe.pauseCollection ? (
                  <button className="ghost small" disabled={busy} onClick={() => run(() => api.unpause(accountId), 'Collection resumed')}>
                    Resume collection
                  </button>
                ) : (
                  <button className="ghost small" disabled={busy} onClick={() => run(() => api.pause(accountId), 'Collection paused')}>
                    Pause (seasonal)
                  </button>
                )}
              </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
