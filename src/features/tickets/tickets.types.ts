// How the ticket entered the draw. 'code' is legacy only (the business-generated
// code entry mode was removed; historical rows may still carry it).
export type EntrySource = 'code' | 'receipt' | 'free' | 'promo' | 'referral';

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
  // 'scanned' = autofilled from the receipt photo by the scan endpoint. Like 'pasted' it is
  // exempt from the typing-speed signal (there was no typing to time).
  receiptInputMethod?: 'typed' | 'pasted' | 'scanned';
  submitterIp?: string; // Captured server-side for fraud ring detection
  // IP-derived US state at submission (requireEntryRegion middleware). Null = unknown.
  submitterState?: string | null;
  // US traffic whose IP resolved outside allowed_states. Soft risk signal, never a block.
  isOutOfRegion?: boolean;
}
