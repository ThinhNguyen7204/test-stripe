import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import AccountPanel from './components/AccountPanel';
import SubscriptionPanel from './components/SubscriptionPanel';
import InvoicesPanel from './components/InvoicesPanel';
import PolicyPanel from './components/PolicyPanel';
import EventsPanel from './components/EventsPanel';
import TimeMachine from './components/TimeMachine';
import XAddonPanel from './components/XAddonPanel';

const TABS = [
  { key: 'subscription', label: 'Subscription' },
  { key: 'invoices', label: 'Invoices & refunds' },
  { key: 'policy', label: 'Billing policy' },
  { key: 'events', label: 'Activity log' },
];

export default function App() {
  const [catalog, setCatalog] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [state, setState] = useState<any>(null);
  const [tab, setTab] = useState('subscription');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  const flash = useCallback((message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(null), 6000);
  }, []);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, successMessage?: string): Promise<T | null> => {
      setBusy(true);
      setError(null);
      try {
        const result = await fn();
        if (successMessage) flash(successMessage);
        setRefreshToken((n) => n + 1);
        return result;
      } catch (err: any) {
        setError(err.message ?? String(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [flash],
  );

  const loadCatalog = useCallback(async () => {
    try {
      setCatalog(await api.catalog());
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const list = await api.accounts();
      setAccounts(list);
      setActiveId((current) => current ?? list[0]?._id ?? null);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadCatalog();
    loadAccounts();
  }, [loadCatalog, loadAccounts]);

  useEffect(() => {
    if (!activeId) {
      setState(null);
      return;
    }
    api
      .state(activeId)
      .then(setState)
      .catch((err) => setError(err.message));
  }, [activeId, refreshToken]);

  useEffect(() => {
    loadAccounts();
  }, [refreshToken, loadAccounts]);

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>OptiSigns billing mechanics — Stripe demo</h1>
          <p className="subtitle">
            Per-screen plans, per-unit add-ons, proration, downgrades, credits and refunds — every rule is a
            setting you can change.
          </p>
        </div>
        <div className="topbar-status">
          <span className={`pill ${catalog?.stripeConfigured ? 'ok' : 'warn'}`}>
            {catalog?.stripeConfigured ? 'Stripe key loaded' : 'No Stripe key'}
          </span>
          <span className={`pill ${catalog?.stripeSynced ? 'ok' : 'warn'}`}>
            {catalog?.stripeSynced ? 'Catalog synced' : 'Catalog not synced'}
          </span>
          <button
            className="ghost"
            disabled={busy}
            onClick={() => run(() => api.syncCatalog(), 'Products and prices synced to Stripe').then(loadCatalog)}
          >
            Sync catalog → Stripe
          </button>
        </div>
      </header>

      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          <strong>Error:</strong> {error} <span className="dismiss">dismiss</span>
        </div>
      )}
      {notice && <div className="banner ok">{notice}</div>}

      <div className="layout">
        <aside className="sidebar">
          <AccountPanel
            accounts={accounts}
            activeId={activeId}
            setActiveId={setActiveId}
            state={state}
            run={run}
            busy={busy}
          />
          {activeId && <XAddonPanel accountId={activeId} state={state} run={run} busy={busy} />}
          {activeId && <TimeMachine accountId={activeId} run={run} busy={busy} refreshToken={refreshToken} />}
        </aside>

        <main className="main">
          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t.key} className={tab === t.key ? 'tab active' : 'tab'} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </nav>

          {!activeId && (tab === 'subscription' || tab === 'invoices') && (
            <div className="empty">Create a demo account on the left to get started.</div>
          )}

          {activeId && tab === 'subscription' && (
            <SubscriptionPanel accountId={activeId} catalog={catalog} state={state} run={run} busy={busy} />
          )}
          {activeId && tab === 'invoices' && (
            <InvoicesPanel accountId={activeId} run={run} busy={busy} refreshToken={refreshToken} />
          )}
          {tab === 'policy' && <PolicyPanel run={run} busy={busy} refreshToken={refreshToken} />}
          {tab === 'events' && <EventsPanel accountId={activeId} run={run} refreshToken={refreshToken} />}
        </main>
      </div>
    </div>
  );
}
