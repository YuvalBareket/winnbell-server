export interface ITicket {
  id: number;
  code: string;
  status: 'Issued' | 'Activated';
  business_name: string;
  business_sector: string;
  activated_at: string;
  draw_name: string;
}
export interface FreeTicketStatus {
  canActivate: boolean;
  nextAvailableDate?: Date;
}

export interface ActivationResult {
  success: boolean;
  ticketId: number;
  code: string;
}
