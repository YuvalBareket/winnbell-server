// ─── Founding plan term - SINGLE SOURCE OF TRUTH ─────────────────────────────
// Change the founding term lengths HERE and nowhere else. Everything derives from
// these: activation period end, fee_at_entry monthly equivalent, renewal extension,
// and both confirmation emails (the client mirrors them in subscribeTiers.ts -
// keep the two files in lockstep).
//
// This lives in shared/ (not stripe.service) so email.service can import it
// without a circular dependency (stripe.service imports email.service).
export const FOUNDING_TERM_MONTHS = 3;          // initial founding term
export const FOUNDING_RENEWAL_TERM_MONTHS = 12; // the one-time renewal term

// The founding offer is a MONTHLY RATE per location, in dollars. Everything derives
// from it: the initial one-time charge (rate x FOUNDING_TERM_MONTHS x locations) and
// the one-time renewal charge (member's snapshotted rate x FOUNDING_RENEWAL_TERM_MONTHS).
// Changing the rate here is the ONLY step to change the price - checkout, availability,
// and all client copy follow (served via the founding-availability endpoint). Members
// snapshot what they paid (founding_member.amount_paid + subscription.fee_at_entry as
// the monthly equivalent), so a change never affects existing members or their renewal.
// TEMPORARY TEST PRICE: $0.17/month -> $0.51 one-time per location (3-month term).
// Revert to 100 before launch.
export const FOUNDING_MONTHLY_PRICE_PER_LOCATION = 0.17;

// Derived one-time total per location for the initial term ($300 at 100 x 3).
export const FOUNDING_PRICE_PER_LOCATION = FOUNDING_MONTHLY_PRICE_PER_LOCATION * FOUNDING_TERM_MONTHS;

// Campaign entries granted per location (Growth-tier allowance). Used by activation,
// the availability endpoint (client checkout copy), and the welcome email.
export const FOUNDING_ENTRIES_PER_LOCATION = 2500;
