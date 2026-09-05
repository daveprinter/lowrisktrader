export type ContractDefId = "digitunder" | "digitover" | "digitdiff";

export type ContractDef = {
  id: ContractDefId;
  /** Deriv contract_type sent in the proposal */
  type: "DIGITUNDER" | "DIGITOVER" | "DIGITDIFF";
  name: string;
  short: string;
  /** Plain-language description of the win condition */
  wins: string;
  /** Approximate win probability at the safest setting */
  winRate: number;
  /** Barrier / prediction control */
  barrier: {
    label: string;
    /** Only these barrier values are allowed — anything riskier is blocked. */
    options: number[];
    /** Safest default */
    safest: number;
  };
  note: string;
};

export const CONTRACTS: ContractDef[] = [
  {
    id: "digitunder",
    type: "DIGITUNDER",
    name: "Digits Under",
    short: "Under",
    wins: "Wins when the last digit of the price is below the barrier",
    winRate: 0.9,
    barrier: { label: "Barrier (digit must be under)", options: [9, 8, 7], safest: 9 },
    note: "Under 9 wins on 9 of 10 digits — the safest digit setting.",
  },
  {
    id: "digitover",
    type: "DIGITOVER",
    name: "Digits Over",
    short: "Over",
    wins: "Wins when the last digit of the price is above the barrier",
    winRate: 0.9,
    barrier: { label: "Barrier (digit must be over)", options: [0, 1, 2], safest: 0 },
    note: "Over 0 wins on 9 of 10 digits — the safest digit setting.",
  },
  {
    id: "digitdiff",
    type: "DIGITDIFF",
    name: "Digits Differs",
    short: "Differs",
    wins: "Wins when the last digit is anything other than your prediction",
    winRate: 0.9,
    barrier: { label: "Prediction (digit must NOT appear)", options: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], safest: 0 },
    note: "Any prediction wins 9 of 10 digits; payout is the same for all.",
  },
];

export const MARKETS = [
  { symbol: "R_10", name: "Volatility 10 Index" },
  { symbol: "R_25", name: "Volatility 25 Index" },
  { symbol: "R_50", name: "Volatility 50 Index" },
  { symbol: "R_75", name: "Volatility 75 Index" },
  { symbol: "R_100", name: "Volatility 100 Index" },
  { symbol: "1HZ10V", name: "Volatility 10 (1s) Index" },
  { symbol: "1HZ25V", name: "Volatility 25 (1s) Index" },
  { symbol: "1HZ50V", name: "Volatility 50 (1s) Index" },
  { symbol: "1HZ100V", name: "Volatility 100 (1s) Index" },
];

export type SwitchMode = "after_loss" | "after_trades" | "consecutive_losses" | "consecutive_wins";

export const SWITCH_MODES: { id: SwitchMode; label: string; hint: string; needsValue: boolean }[] = [
  { id: "after_loss", label: "After a loss", hint: "Move to the next contract as soon as one loses", needsValue: false },
  { id: "after_trades", label: "After X trades", hint: "Stay on a contract for a fixed number of trades", needsValue: true },
  { id: "consecutive_losses", label: "After X losses in a row", hint: "Switch only on a losing streak", needsValue: true },
  { id: "consecutive_wins", label: "After X wins in a row", hint: "Switch only on a winning streak", needsValue: true },
];

/** The lowest-risk configuration for the whole tool. */
export const RECOMMENDED = {
  stake: "0.35",
  martingale: "1",
  takeProfit: "2",
  stopLoss: "5",
  symbol: "R_10",
  speed: "normal" as "tick" | "normal",
  switchMode: "consecutive_losses" as SwitchMode,
  switchValue: "2",
  selected: ["digitunder", "digitover"] as ContractDefId[],
  barriers: { digitunder: 9, digitover: 0, digitdiff: 0 } as Record<ContractDefId, number>,
};
