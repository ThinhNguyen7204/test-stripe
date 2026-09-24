/**
 * OptiSigns public pricing (USD), taken from optisigns.com/pricing.
 * Verified against the live page (monthly + annual toggle) on 17 Sep 2026.
 *
 *  - every paid plan is priced *per screen, per month*
 *  - the annual term is the same plan at exactly 10% off, billed 12 months up front
 *  - add-ons are separate per-unit licences that ride on the same subscription
 *    and follow the same term as the base plan
 *
 * The live price book has five tiers: Free, Standard, Pro Plus, Engage and
 * Enterprise. Enterprise ($45 / $40.50 per screen, minimum 25 screens) is
 * sales-only ("Talk With Sales"), so it is left out of this self-serve demo —
 * add it back by appending one entry to PLANS if you need the minimum-quantity
 * mechanic. There is no "Pro" tier.
 */
export type ItemKind = 'plan' | 'addon';

export interface CatalogItemDef {
  code: string;
  kind: ItemKind;
  name: string;
  description: string;
  /** what one unit of quantity means: a screen licence, a video wall, ... */
  unitLabel: string;
  /** higher rank = higher tier; used to classify upgrade vs downgrade */
  tierRank: number;
  /** price per unit per month on the monthly term, in cents */
  monthlyCents: number;
  /** effective price per unit per month on the annual term, in cents (10% off) */
  annualMonthlyCents: number;
  minQuantity: number;
  maxQuantity?: number;
  /** add-on quantity may never exceed the number of screens on the base plan */
  boundToScreens?: boolean;
  /**
   * Licensed against the account rather than against a screen, so the
   * add-on ≤ screens rule does not apply.
   */
  perAccount?: boolean;
  /**
   * Post Updates a fully paid quota month grants. Informational on the price
   * book: the X add-on's quota ledger is SCIO's (MODEL V6 row 6) and follows
   * paid TIME, never quantity or money — see x-addon/quota-math.ts.
   */
  quotaAllowance?: number;
  quotaLabel?: string;
  features: string[];
}

export const PLANS: CatalogItemDef[] = [
  {
    code: 'free',
    kind: 'plan',
    name: 'Free',
    description:
      'Up to 3 screens with 25 basic apps and 1 GB storage, OptiSigns logo on screen. No Stripe subscription is created.',
    unitLabel: 'screen',
    tierRank: 0,
    monthlyCents: 0,
    annualMonthlyCents: 0,
    minQuantity: 0,
    maxQuantity: 3,
    features: ['Up to 3 screens', '25 basic apps', '1 GB storage', 'Up to 3 users', 'OptiSigns logo on screens'],
  },
  {
    code: 'standard',
    kind: 'plan',
    name: 'Standard',
    description: 'Digital signage simplified — playlists, schedules and the app library.',
    unitLabel: 'screen',
    tierRank: 1,
    monthlyCents: 1000,
    annualMonthlyCents: 900,
    minQuantity: 1,
    features: [
      'Build playlists & schedule content',
      '100+ apps & integrations',
      'Ready to use templates & feeds',
      'Split screen zones',
      'Unlimited cloud storage · up to 25 users',
      'Email support',
    ],
  },
  {
    code: 'pro_plus',
    kind: 'plan',
    name: 'Pro Plus',
    description: 'Most popular — data integrations, workflow, reporting and security.',
    unitLabel: 'screen',
    tierRank: 2,
    monthlyCents: 1500,
    annualMonthlyCents: 1350,
    minQuantity: 1,
    features: [
      'Everything in Standard, and:',
      'Microsoft 365 & Google Workspace integration',
      'Dashboards (Power BI, Salesforce, Looker)',
      'OptiSync dynamic data mapping',
      'Auto power on/off TV · remote troubleshooting',
      'Team workspaces, approval workflow, audit logs, SAML SSO',
      'Proof of play reporting · campaign management',
      'Unlimited users · email & phone support',
    ],
  },
  {
    code: 'engage',
    kind: 'plan',
    name: 'Engage',
    description: 'Interactive digital experiences — kiosks, scan-to-interact, event analytics.',
    unitLabel: 'screen',
    tierRank: 3,
    monthlyCents: 3000,
    annualMonthlyCents: 2700,
    minQuantity: 1,
    features: [
      'Everything in Pro Plus, and:',
      'Interactive kiosk designer',
      'Transform catalogues into kiosks',
      'Lift & Learn · Check-In app',
      'QR scan-to-interact · live TV ads overlay',
      'Event based analytics · custom data residency',
      'Email, phone & Zoom support',
    ],
  },
];

export const ADDONS: CatalogItemDef[] = [
  {
    code: 'video_wall',
    kind: 'addon',
    name: 'Video Wall',
    description: 'Drives one synchronised video wall. Priced per wall, not per screen.',
    unitLabel: 'wall',
    tierRank: 0,
    monthlyCents: 2500,
    annualMonthlyCents: 2250,
    minQuantity: 0,
    features: ['Multi-screen canvas', 'Synchronised playback'],
  },
  {
    code: 'opti_sound',
    kind: 'addon',
    name: 'Background Music',
    description: 'Licensed background music, per screen.',
    unitLabel: 'screen',
    tierRank: 0,
    monthlyCents: 1500,
    annualMonthlyCents: 1350,
    minQuantity: 0,
    boundToScreens: true,
    features: ['Licensed music catalogue', 'Per-screen playlists'],
  },
  {
    code: 'aericast',
    kind: 'addon',
    name: 'Wireless Presentation',
    description: 'Unlocks unlimited wireless presentation sessions for meeting rooms, per screen.',
    unitLabel: 'screen',
    tierRank: 0,
    monthlyCents: 2000,
    annualMonthlyCents: 1800,
    minQuantity: 0,
    boundToScreens: true,
    features: ['Unlimited session length', 'Video conferencing support'],
  },
];

/**
 * X Social — MODEL V6 row 4: exactly one add-on per tenant, quantity fixed at
 * 1, $20 a month or $216 a year ($20 × 12 × 90%). No tiers, no quantity: the
 * Standard/Pro split and per-licence quantity of V5 are gone (row 48).
 *
 * Money is Stripe's and is prorated natively like any other item. Quota is
 * SCIO's: 2,000 Post Updates for each fully paid calendar quota month, granted
 * by paid time (rows 5, 6, 47).
 */
export const X_SOCIAL_ADDON: CatalogItemDef = {
  code: 'x_social',
  kind: 'addon',
  name: 'X Social',
  description:
    'Pull X (Twitter) content onto your screens. 2,000 Post Updates each quota month, up to 10 Profile Sources, one per account.',
  unitLabel: 'account',
  tierRank: 0,
  monthlyCents: 2000,
  annualMonthlyCents: 1800,
  minQuantity: 0,
  maxQuantity: 1,
  perAccount: true,
  quotaAllowance: 2000,
  quotaLabel: 'Post Updates',
  features: ['2,000 Post Updates per quota month', 'Up to 10 Profile Sources', 'Hashtag Sources', 'One per account'],
};

export const CATALOG: CatalogItemDef[] = [...PLANS, ...ADDONS, X_SOCIAL_ADDON];

export const FREE_PLAN_CODE = 'free';
export const ANNUAL_DISCOUNT_PERCENT = 10;

export type BillingTerm = 'monthly' | 'yearly';

/** Stripe unit_amount for a catalog item on a given term. */
export function stripeUnitAmount(item: CatalogItemDef, term: BillingTerm): number {
  return term === 'yearly' ? item.annualMonthlyCents * 12 : item.monthlyCents;
}

export function lookupKey(code: string, term: BillingTerm): string {
  return `optisigns_demo_${code}_${term}`;
}
