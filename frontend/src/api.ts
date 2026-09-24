const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = body?.message?.message ?? body?.message ?? res.statusText;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return body as T;
}

export const api = {
  catalog: () => request<any>('/catalog'),
  syncCatalog: () => request<any>('/catalog/sync-stripe', { method: 'POST' }),

  accounts: () => request<any[]>('/accounts'),
  createAccount: (body: any) => request<any>('/accounts', { method: 'POST', body: JSON.stringify(body) }),
  deleteAccount: (id: string) => request<any>(`/accounts/${id}`, { method: 'DELETE' }),
  testCards: () => request<any[]>('/accounts/test-cards'),
  attachTestCard: (id: string, kind: string) =>
    request<any>(`/accounts/${id}/payment-method/test`, { method: 'POST', body: JSON.stringify({ kind }) }),
  balance: (id: string) => request<any>(`/accounts/${id}/balance`),
  adjustBalance: (id: string, amountCents: number, description: string) =>
    request<any>(`/accounts/${id}/balance`, { method: 'POST', body: JSON.stringify({ amountCents, description }) }),
  portalSession: (id: string) =>
    request<any>(`/billing/accounts/${id}/portal-session`, { method: 'POST', body: JSON.stringify({}) }),
  syncPortalConfig: () => request<any>('/billing/portal/configuration', { method: 'POST' }),

  state: (id: string) => request<any>(`/subscriptions/${id}`),
  preview: (id: string, body: any) =>
    request<any>(`/subscriptions/${id}/preview`, { method: 'POST', body: JSON.stringify(body) }),
  change: (id: string, body: any) =>
    request<any>(`/subscriptions/${id}/change`, { method: 'POST', body: JSON.stringify(body) }),
  cancel: (id: string, body: any) =>
    request<any>(`/subscriptions/${id}/cancel`, { method: 'POST', body: JSON.stringify(body) }),
  resume: (id: string) => request<any>(`/subscriptions/${id}/resume`, { method: 'POST' }),
  cancelScheduledChange: (id: string) =>
    request<any>(`/subscriptions/${id}/cancel-scheduled-change`, { method: 'POST' }),
  endTrial: (id: string) => request<any>(`/subscriptions/${id}/end-trial`, { method: 'POST' }),
  pause: (id: string) => request<any>(`/subscriptions/${id}/pause`, { method: 'POST', body: JSON.stringify({}) }),
  unpause: (id: string) => request<any>(`/subscriptions/${id}/unpause`, { method: 'POST' }),
  renewalPreview: (id: string) => request<any>(`/subscriptions/${id}/renewal-preview`),

  // the X add-on, MODEL V6
  xPreview: (id: string, action: 'purchase' | 'cancel' | 'resume') =>
    request<any>(`/x-addon/${id}/preview/${action}`, { method: 'POST' }),
  xCancel: (id: string) => request<any>(`/x-addon/${id}/cancel`, { method: 'POST' }),
  xResume: (id: string) => request<any>(`/x-addon/${id}/resume`, { method: 'POST' }),
  xTrial: (id: string) => request<any>(`/x-addon/${id}/trial`, { method: 'POST' }),
  xSyncRun: (id: string, body: { kind: string; requested?: number; returned: number; actionId?: string }) =>
    request<any>(`/x-addon/${id}/sync-runs`, { method: 'POST', body: JSON.stringify(body) }),

  invoices: (id: string) => request<any[]>(`/billing/accounts/${id}/invoices`),
  payInvoice: (invoiceId: string) => request<any>(`/billing/invoices/${invoiceId}/pay`, { method: 'POST' }),
  voidInvoice: (invoiceId: string) => request<any>(`/billing/invoices/${invoiceId}/void`, { method: 'POST' }),
  refund: (id: string, body: any) =>
    request<any>(`/billing/accounts/${id}/refund`, { method: 'POST', body: JSON.stringify(body) }),
  creditNotes: (id: string) => request<any[]>(`/billing/accounts/${id}/credit-notes`),
  refunds: (id: string) => request<any[]>(`/billing/accounts/${id}/refunds`),

  policy: () => request<any>('/policy'),
  policyFields: () => request<any>('/policy/fields'),
  policyPresets: () => request<any[]>('/policy/presets'),
  updatePolicy: (patch: any) => request<any>('/policy', { method: 'PUT', body: JSON.stringify(patch) }),
  applyPreset: (key: string) => request<any>(`/policy/presets/${key}`, { method: 'POST' }),

  clock: (id: string) => request<any>(`/simulator/${id}/clock`),
  advance: (id: string, body: any) =>
    request<any>(`/simulator/${id}/advance`, { method: 'POST', body: JSON.stringify(body) }),

  events: (id?: string) => request<any[]>(`/events${id ? `?accountId=${id}` : ''}`),
  clearEvents: (id?: string) => request<any>(`/events${id ? `?accountId=${id}` : ''}`, { method: 'DELETE' }),
};

export const money = (cents: number | null | undefined, currency = 'usd') => {
  const value = (cents ?? 0) / 100;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(value);
};

export const when = (epoch?: number | null) =>
  epoch ? new Date(epoch * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export const day = (epoch?: number | null) =>
  epoch ? new Date(epoch * 1000).toLocaleDateString('en-GB', { dateStyle: 'medium' }) : '—';
