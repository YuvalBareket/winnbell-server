export interface IDrawSummary {
  id: number;
  name: string;
  prize_amount: number;
  // Campaign period: opens midnight NY on the 1st (start_date), drawn on the last day (draw_date).
  start_date: string;
  draw_date: string;
  status: string;
}
