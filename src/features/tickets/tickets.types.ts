// Entry source distinguishes MVP code-based entries from v2 receipt-based entries
export type EntrySource = 'code' | 'receipt';

export interface ITicket {
  id: number;
  code: string;
  status: 'Issued' | 'Activated';
  business_name: string;
  business_sector: string;
  activated_at: string;
  draw_name: string;
  // v2 fields (nullable in MVP)
  entry_source: EntrySource;
  receipt_identifier: string | null;
  transaction_amount: number | null;
  receipt_image_url: string | null;
  risk_score: number;
}

export interface FreeTicketStatus {
  canActivate: boolean;
  nextAvailableDate?: Date;
  reason?: string;
}

export interface ActivationResult {
  success: boolean;
  ticketId: number;
  code: string;
}

// ─── V2 Receipt Entry Input ───────────────────────────────────────────────────
// Not used in MVP. Defines the shape of a receipt-based entry submission.
export interface ReceiptEntryInput {
  locationId: number;
  receiptIdentifier: string;
  transactionAmount: number;
  transactionDate?: string; // ISO date string (YYYY-MM-DD), stored for later receipt verification
  receiptImageUrl?: string;
  typingDurationMs?: number;
  receiptInputMethod?: 'typed' | 'pasted';
  submitterIp?: string; // Captured server-side for fraud ring detection
}
