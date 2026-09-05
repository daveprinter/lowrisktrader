export type ContractDefId =
  | "digitunder"
  | "digitover"
  | "digitdiff"
  | "rise"
  | "fall"
  | "riseequal"
  | "fallequal"
  | "resetcall"
  | "resetput"
  | "multup"
  | "multdown";

/** How the contract has to be priced, bought and settled. */
export type ContractKind = "digit" | "updown" | "reset" | "multiplier";

export type ContractDef = {
  id: ContractDefId;
  /** Deriv contract_type sent in the proposal */
  type:
    | "DIGITUNDER"
    | "DIGITOVER"
    | "DIGITDIFF"
    | "CALL"
    | "PUT"
    | "CALLE"
    | "PUTE"
    | "RESETCALL"
    | "RESETPUT"
    | "MULTUP"
    | "MULTDOWN";
  kind: ContractKind;
  name: string;
  short: string;
  /** Plain-language description of the win condition */
  wins: string;
  /** Approximate win probability at the safest setting */
  winRate: number;
  /** Barrier / prediction control (digit contracts only) */
  barrier?: {
    label: string;
    /** Only these barrier values are allowed — anything riskier is blocked. */
    options: number[];
    /** Safest default */
    safest: number;
  };
  /** Duration in ticks (up/down and reset contracts) */
  duration?: {
    label: string;
    options: number[];
    safest: number;
  };
  /** Multiplier level (multiplier contracts only) */
  multiplier?: {
    label: string;
    options: number[];
    safest: number;
  };
  note: string;
};

export const CONTRACTS: ContractDef[] = [
  {
    id: "digitunder",
    type: "DIGITUNDER",
    kind: "digit",
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
    kind: "digit",
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
    kind: "digit",
    name: "Digits Differs",
    short: "Differs",
    wins: "Wins when the last digit is anything other than your prediction",
    winRate: 0.9,
    barrier: { label: "Prediction (digit must NOT appear)", options: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], safest: 0 },
    note: "Any prediction wins 9 of 10 digits; payout is the same for all.",
  },
  {
    id: "rise",
    type: "CALL",
    kind: "updown",
    name: "Rise",
    short: "Rise",
    wins: "Wins when the price ends above where it started",
    winRate: 0.5,
    duration: { label: "Duration (ticks)", options: [1, 2, 3, 5], safest: 5 },
    note: "No barrier at all — the entry price is the reference, so nothing extra has to be predicted.",
  },
  {
    id: "fall",
    type: "PUT",
    kind: "updown",
    name: "Fall",
    short: "Fall",
    wins: "Wins when the price ends below where it started",
    winRate: 0.5,
    duration: { label: "Duration (ticks)", options: [1, 2, 3, 5], safest: 5 },
    note: "No barrier at all — the entry price is the reference, so nothing extra has to be predicted.",
  },
  {
    id: "riseequal",
    type: "CALLE",
    kind: "updown",
    name: "Rise or Equal",
    short: "Rise=",
    wins: "Wins when the price ends above OR exactly at the start price",
    winRate: 0.52,
    duration: { label: "Duration (ticks)", options: [1, 2, 3, 5], safest: 5 },
    note: "A tie counts as a win, so it is slightly safer than plain Rise.",
  },
  {
    id: "fallequal",
    type: "PUTE",
    kind: "updown",
    name: "Fall or Equal",
    short: "Fall=",
    wins: "Wins when the price ends below OR exactly at the start price",
    winRate: 0.52,
    duration: { label: "Duration (ticks)", options: [1, 2, 3, 5], safest: 5 },
    note: "A tie counts as a win, so it is slightly safer than plain Fall.",
  },
  {
    id: "resetcall",
    type: "RESETCALL",
    kind: "reset",
    name: "Reset Up",
    short: "Reset Up",
    wins: "Wins if the price ends above the start — or above the halfway reset price",
    winRate: 0.55,
    duration: { label: "Duration (ticks)", options: [5, 6, 10], safest: 5 },
    note: "Halfway through, the reference price resets in your favour if you are behind — a second chance.",
  },
  {
    id: "resetput",
    type: "RESETPUT",
    kind: "reset",
    name: "Reset Down",
    short: "Reset Dn",
    wins: "Wins if the price ends below the start — or below the halfway reset price",
    winRate: 0.55,
    duration: { label: "Duration (ticks)", options: [5, 6, 10], safest: 5 },
    note: "Halfway through, the reference price resets in your favour if you are behind — a second chance.",
  },
  {
    id: "multup",
    type: "MULTUP",
    kind: "multiplier",
    name: "Multiplier Up",
    short: "Mult Up",
    wins: "Profits while the price rises; closes automatically at your take profit or stop loss",
    winRate: 0.5,
    multiplier: { label: "Multiplier", options: [20, 30, 40, 50, 100], safest: 20 },
    note: "Loss is capped by a built-in stop loss and you never lose more than the stake.",
  },
  {
    id: "multdown",
    type: "MULTDOWN",
    kind: "multiplier",
    name: "Multiplier Down",
    short: "Mult Dn",
    wins: "Profits while the price falls; closes automatically at your take profit or stop loss",
    winRate: 0.5,
    multiplier: { label: "Multiplier", options: [20, 30, 40, 50, 100], safest: 20 },
    note: "Loss is capped by a built-in stop loss and you never lose more than the stake.",
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

/** Safest built-in value for every contract control. */
export const DEFAULT_BARRIERS: Record<ContractDefId, number> = CONTRACTS.reduce(
  (acc, c) => {
    acc[c.id] = c.barrier?.safest ?? 0;
    return acc;
  },
  {} as Record<ContractDefId, number>,
);

/** Default stake for every contract when alternate per-contract stakes are on. */
export const DEFAULT_STAKES: Record<ContractDefId, string> = CONTRACTS.reduce(
  (acc, c) => {
    acc[c.id] = "0.35";
    return acc;
  },
  {} as Record<ContractDefId, string>,
);

export const DEFAULT_DURATIONS: Record<ContractDefId, number> = CONTRACTS.reduce(
  (acc, c) => {
    acc[c.id] = c.duration?.safest ?? 1;
    return acc;
  },
  {} as Record<ContractDefId, number>,
);

export const DEFAULT_MULTIPLIERS: Record<ContractDefId, number> = CONTRACTS.reduce(
  (acc, c) => {
    acc[c.id] = c.multiplier?.safest ?? 20;
    return acc;
  },
  {} as Record<ContractDefId, number>,
);

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
  barriers: { ...DEFAULT_BARRIERS },
  durations: { ...DEFAULT_DURATIONS },
  multipliers: { ...DEFAULT_MULTIPLIERS },
};
