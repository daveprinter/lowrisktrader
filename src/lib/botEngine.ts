import { DerivWS, roundStake } from "./deriv";
import { CONTRACTS, DEFAULT_DURATIONS, DEFAULT_MULTIPLIERS, type ContractDefId, type SwitchMode } from "./contracts";

export type SpeedMode = "tick" | "normal";
export type TradeState = "idle" | "buying" | "awaiting";

export type BotConfig = {
  symbol: string;
  stake: number;
  /** When on, each contract uses its own base stake from `stakes`. */
  usePerContractStakes?: boolean;
  stakes?: Record<ContractDefId, number>;
  martingale: number;
  takeProfit: number;
  stopLoss: number;
  speed: SpeedMode;
  selected: ContractDefId[];
  barriers: Record<ContractDefId, number>;
  durations?: Record<ContractDefId, number>;
  multipliers?: Record<ContractDefId, number>;
  switchMode: SwitchMode;
  switchValue: number;
};

export type LogEntry = {
  id: number;
  time: string;
  level: "info" | "win" | "loss" | "error";
  message: string;
};

export type Stats = {
  runs: number;
  wins: number;
  losses: number;
  profit: number;
  currentStake: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  activeContract: ContractDefId | null;
  tradesOnContract: number;
};

export type BotEvents = {
  onLog: (level: LogEntry["level"], message: string) => void;
  onStats: (stats: Stats) => void;
  onTick: (digit: number, price: string) => void;
  onState: (state: TradeState) => void;
  onStopped: (reason: string) => void;
  onBalance: (balance: number) => void;
};

const emptyStats = (stake: number): Stats => ({
  runs: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  currentStake: stake,
  consecutiveWins: 0,
  consecutiveLosses: 0,
  activeContract: null,
  tradesOnContract: 0,
});

export class BotEngine {
  private ws: DerivWS;
  private cfg: BotConfig;
  private ev: BotEvents;
  private currency: string;

  private running = false;
  private tradeState: TradeState = "idle";
  private pending: {
    defId: ContractDefId;
    buyPrice: number;
    payout: number;
    type: string;
    barrier: number;
    kind: "digit" | "updown" | "reset" | "multiplier";
    contractId?: number | undefined;
  } | null = null;

  private stats: Stats;
  private baseStake: number;
  private currentStake: number;
  /** Live martingale stake per contract (keyed by contract id). */
  private currentStakes: Partial<Record<ContractDefId, number>> = {};
  private contractIndex = 0;
  private digits: number[] = [];
  private tickSeen = false;
  private balance: number | null = null;
  private balanceAttached = false;

  /** Set the starting balance and stream live balance updates from Deriv. */
  attachBalance(initial: number) {
    this.balance = Math.round(initial * 100) / 100;
    this.ev.onBalance(this.balance);
    if (this.balanceAttached) return;
    this.balanceAttached = true;
    try {
      this.ws.subscribe({ balance: 1 }, (data) => {
        const b = data?.balance?.balance;
        if (b === undefined) return;
        this.balance = Math.round(Number(b) * 100) / 100;
        this.ev.onBalance(this.balance);
      });
    } catch {
      /* balance stream optional — optimistic updates still apply */
    }
  }

  private bumpBalance(delta: number) {
    if (this.balance === null) return;
    this.balance = Math.round((this.balance + delta) * 100) / 100;
    this.ev.onBalance(this.balance);
  }


  constructor(ws: DerivWS, cfg: BotConfig, currency: string, ev: BotEvents) {
    this.ws = ws;
    this.cfg = cfg;
    this.ev = ev;
    this.currency = currency;
    this.baseStake = roundStake(cfg.stake);
    this.currentStake = this.baseFor(cfg.selected[0]!);
    this.stats = emptyStats(this.baseStake);
    this.stats.currentStake = this.currentStake;
    this.stats.activeContract = cfg.selected[0] ?? null;
  }

  /** Base stake for a contract — its own stake when alternate mode is on. */
  private baseFor(id: ContractDefId): number {
    if (this.cfg.usePerContractStakes) {
      return roundStake(this.cfg.stakes?.[id] ?? this.cfg.stake);
    }
    return this.baseStake;
  }

  updateConfig(cfg: Partial<BotConfig>) {
    this.cfg = { ...this.cfg, ...cfg };
    if (cfg.stake !== undefined) this.baseStake = roundStake(cfg.stake);
    if (!this.running && (cfg.stake !== undefined || cfg.stakes !== undefined || cfg.usePerContractStakes !== undefined)) {
      this.currentStakes = {};
      this.currentStake = this.baseFor(this.activeDef().id);
      this.stats.currentStake = this.currentStake;
      this.push();
    }
  }

  get isRunning() {
    return this.running;
  }

  getStats() {
    return { ...this.stats };
  }

  private push() {
    this.ev.onStats({ ...this.stats });
  }

  private setState(s: TradeState) {
    this.tradeState = s;
    this.ev.onState(s);
  }

  /** Subscribe to the tick stream. Falls back through request shapes until one streams. */
  attachTicks() {
    const symbol = this.cfg.symbol;
    this.tickSeen = false;

    try {
      this.ws.forgetTicks();
    } catch {
      /* ignore */
    }

    const variants: Record<string, any>[] =
      this.ws.mode === "pat"
        ? [
            { ticks: symbol, underlying_symbol: symbol },
            { ticks: 1, underlying_symbol: symbol },
            { ticks: symbol },
          ]
        : [{ ticks: symbol }, { ticks: symbol, underlying_symbol: symbol }];

    const tryVariant = (i: number) => {
      if (i >= variants.length) {
        this.ev.onLog("error", `Could not stream prices for ${symbol}. Try another market or reconnect.`);
        return;
      }
      try {
        this.ws.subscribe(variants[i]!, (data) => {
          if (data?.error) {
            if (!this.tickSeen) {
              this.ev.onLog("info", `Price stream retry (${data.error.message || data.error.code || "error"})`);
              tryVariant(i + 1);
            }
            return;
          }
          const tick = data?.tick ?? data?.ticks ?? data?.data?.tick;
          if (!tick || tick.quote === undefined) return;
          this.tickSeen = true;
          this.handleTick(tick);
        });
      } catch (error: any) {
        this.ev.onLog("error", error?.message || "Could not subscribe to prices");
        return;
      }

      // If nothing arrives shortly, try the next request shape.
      setTimeout(() => {
        if (!this.tickSeen && i + 1 < variants.length) tryVariant(i + 1);
      }, 6000);
    };

    tryVariant(0);
    void this.seedPrice(symbol);
  }

  /** One-off latest price so the market shows something immediately. */
  private async seedPrice(symbol: string) {
    try {
      const res: any = await this.ws.send({
        ticks_history: symbol,
        ...(this.ws.mode === "pat" ? { underlying_symbol: symbol } : {}),
        end: "latest",
        count: 20,
        style: "ticks",
      });
      const prices: any[] = res?.history?.prices ?? [];
      const pipSize = res?.pip_size ?? 2;
      for (const p of prices) {
        if (this.tickSeen) return;
        const priceStr = Number(p).toFixed(pipSize);
        const digit = parseInt(priceStr[priceStr.length - 1]!, 10);
        this.digits = [...this.digits, digit].slice(-200);
        this.ev.onTick(digit, priceStr);
      }
    } catch {
      /* optional */
    }
  }


  start() {
    if (this.running) return;
    if (!this.cfg.selected.length) {
      this.ev.onLog("error", "Pick at least one contract first.");
      return;
    }
    this.running = true;
    this.currentStakes = {};
    this.currentStake = this.baseFor(this.activeDef().id);
    this.currentStakes[this.activeDef().id] = this.currentStake;
    this.stats.currentStake = this.currentStake;
    this.stats.activeContract = this.activeDef().id;
    this.stats.tradesOnContract = 0;
    this.push();
    this.ev.onLog(
      "info",
      `Started — ${this.cfg.speed === "tick" ? "every tick" : "normal speed"} mode on ${this.cfg.symbol}`,
    );
  }

  stop(reason = "Stopped") {
    if (!this.running) return;
    this.running = false;
    this.ev.onLog("info", reason);
    this.ev.onStopped(reason);
  }

  private activeDef() {
    const list = this.cfg.selected;
    const id = list[this.contractIndex % list.length];
    return CONTRACTS.find((c) => c.id === id)!;
  }

  private nextContract() {
    if (this.cfg.selected.length < 2) return;
    this.contractIndex = (this.contractIndex + 1) % this.cfg.selected.length;
    this.stats.tradesOnContract = 0;
    this.stats.activeContract = this.activeDef().id;
    // Resume this contract's own stake progression (per-contract base when alternate mode is on).
    this.currentStake = this.currentStakes[this.activeDef().id] ?? this.baseFor(this.activeDef().id);
    this.currentStakes[this.activeDef().id] = this.currentStake;
    this.stats.currentStake = this.currentStake;
    this.ev.onLog("info", `Switched to ${this.activeDef().name} — stake ${this.currentStake.toFixed(2)}`);
  }

  private maybeSwitch(isWin: boolean) {
    const { switchMode, switchValue } = this.cfg;
    const n = Math.max(1, Math.floor(switchValue || 1));
    if (switchMode === "after_loss") {
      if (!isWin) this.nextContract();
    } else if (switchMode === "after_trades") {
      if (this.stats.tradesOnContract >= n) this.nextContract();
    } else if (switchMode === "consecutive_losses") {
      if (this.stats.consecutiveLosses >= n) this.nextContract();
    } else if (switchMode === "consecutive_wins") {
      if (this.stats.consecutiveWins >= n) this.nextContract();
    }
  }

  private handleTick(tick: any) {
    const pipSize = tick.pip_size ?? 2;
    const priceStr = Number(tick.quote).toFixed(pipSize);
    const digit = parseInt(priceStr[priceStr.length - 1]!, 10);

    this.digits = [...this.digits, digit].slice(-200);
    this.ev.onTick(digit, priceStr);

    // Settle pending trade on THIS tick (every-tick mode settles locally, digits only)
    if (
      this.cfg.speed === "tick" &&
      this.tradeState === "awaiting" &&
      this.pending &&
      this.pending.kind === "digit"
    ) {
      const { buyPrice, payout, type, barrier } = this.pending;
      const isWin =
        type === "DIGITUNDER" ? digit < barrier : type === "DIGITOVER" ? digit > barrier : digit !== barrier;
      const profit = isWin ? payout - buyPrice : -buyPrice;
      this.pending = null;
      this.setState("idle");
      this.processResult(isWin, profit, digit, buyPrice);
    }

    // Auto-trade on the SAME tick
    if (this.running && this.tradeState === "idle") {
      void this.placeTrade();
    }
  }

  private async placeTrade() {
    if (this.tradeState !== "idle" || !this.running) return;

    const def = this.activeDef();
    const stake = roundStake(this.currentStake);
    const barrier = this.cfg.barriers[def.id] ?? def.barrier?.safest ?? 0;
    const ticks = Math.max(1, Math.floor(this.cfg.durations?.[def.id] ?? DEFAULT_DURATIONS[def.id] ?? 1));
    const multiplier = Math.max(1, Math.floor(this.cfg.multipliers?.[def.id] ?? DEFAULT_MULTIPLIERS[def.id] ?? 20));

    this.setState("buying");

    const contractParams: Record<string, any> = {
      amount: stake,
      basis: "stake",
      contract_type: def.type,
      currency: this.currency || "USD",
    };

    if (def.kind === "digit") {
      // Digit contracts: one tick, digit barrier.
      contractParams["duration"] = 1;
      contractParams["duration_unit"] = "t";
      contractParams["barrier"] = String(barrier);
    } else if (def.kind === "updown" || def.kind === "reset") {
      // Rise/Fall, Rise=/Fall= and Reset contracts: short tick duration, NO barrier.
      contractParams["duration"] = ticks;
      contractParams["duration_unit"] = "t";
    } else {
      // Multipliers: no duration; loss capped by a built-in stop loss.
      contractParams["multiplier"] = multiplier;
      contractParams["limit_order"] = {
        take_profit: roundStake(Math.max(0.1, stake * 0.5)),
        stop_loss: roundStake(Math.max(0.1, stake * 0.9)),
      };
    }


    try {
      const buyRes: any =
        this.ws.mode === "pat"
          ? await this.buyViaProposal(contractParams, stake)
          : await this.ws.send({
              buy: 1,
              price: stake,
              parameters: { ...contractParams, symbol: this.cfg.symbol },
            });

      const buy = buyRes?.buy || buyRes?.data?.buy || buyRes;
      const buyPrice = Number(buy?.buy_price ?? stake);
      const payout = Number(buy?.payout ?? 0);
      const contractId = Number(buy?.contract_id ?? 0) || undefined;

      this.pending = { buyPrice, payout, type: def.type, barrier, contractId, kind: def.kind };
      this.bumpBalance(-buyPrice); // show the stake leaving the account immediately
      this.setState("awaiting");
      const detail =
        def.kind === "digit"
          ? `barrier ${barrier}`
          : def.kind === "multiplier"
            ? `x${multiplier}`
            : `${ticks} tick${ticks === 1 ? "" : "s"}`;
      this.ev.onLog("info", `Bought ${def.short} ${detail} — stake ${buyPrice.toFixed(2)}`);

      // Only digit contracts can be settled locally on the next tick.
      if (this.cfg.speed === "normal" || def.kind !== "digit") this.watchContract();
    } catch (error: any) {
      this.ev.onLog("error", error?.message || "Trade failed");
      this.setState("idle");
      if (/insufficient|balance|authoriz|token/i.test(String(error?.message))) {
        this.stop("Stopped after a Deriv error");
      }
    }
  }

  private async buyViaProposal(contractParams: Record<string, any>, stake: number): Promise<any> {
    const proposalRes: any = await this.ws.send({
      proposal: 1,
      ...contractParams,
      underlying_symbol: this.cfg.symbol,
    });

    const proposalId = proposalRes?.proposal?.id;

    if (!proposalId) {
      throw new Error("Deriv did not return a proposal ID");
    }

    return this.ws.send({ buy: proposalId, price: stake });
  }

  /** Normal speed mode: wait for the contract to settle completely. */
  private watchContract() {
    const pending = this.pending;
    if (!pending?.contractId) {
      // Fall back to local settlement on the next tick.
      return;
    }
    const id = pending.contractId;
    this.ws.subscribe({ proposal_open_contract: 1, contract_id: id }, (data) => {
      if (data?.error) {
        this.ev.onLog("error", data.error.message || "Could not track contract");
        this.setState("idle");
        return;
      }
      const poc = data?.proposal_open_contract;
      if (!poc || !poc.is_sold) return;
      if (!this.pending || this.pending.contractId !== id) return;

      const profit = Number(poc.profit ?? 0);
      const isWin = profit >= 0;
      const buyPrice = Number(poc.buy_price ?? this.pending.buyPrice);
      const digit = this.digits[this.digits.length - 1] ?? -1;
      this.pending = null;
      this.setState("idle");
      this.processResult(isWin, profit, digit, buyPrice);
    });
  }

  private processResult(isWin: boolean, profit: number, digit: number, buyPrice: number) {
    // Stake was subtracted at buy time; settle returns stake + profit.
    this.bumpBalance(buyPrice + profit);
    this.stats.runs += 1;
    this.stats.tradesOnContract += 1;
    this.stats.profit = Math.round((this.stats.profit + profit) * 100) / 100;

    if (isWin) {
      this.stats.wins += 1;
      this.stats.consecutiveWins += 1;
      this.stats.consecutiveLosses = 0;
    } else {
      this.stats.losses += 1;
      this.stats.consecutiveLosses += 1;
      this.stats.consecutiveWins = 0;
    }

    this.ev.onLog(
      isWin ? "win" : "loss",
      `${isWin ? "WON" : "LOST"} ${profit >= 0 ? "+" : ""}${profit.toFixed(2)} — last digit ${digit} (stake ${buyPrice.toFixed(2)})`,
    );

    // Synchronous martingale update
    const multiplier = this.cfg.martingale;
    if (isWin) {
      this.currentStake = this.baseStake;
    } else if (!isNaN(multiplier) && multiplier > 1) {
      this.currentStake = roundStake(this.currentStake * multiplier);
    }
    this.stats.currentStake = this.currentStake;

    this.maybeSwitch(isWin);
    this.push();

    if (this.cfg.takeProfit > 0 && this.stats.profit >= this.cfg.takeProfit) {
      this.stop(`Take profit reached (+${this.stats.profit.toFixed(2)})`);
      return;
    }
    if (this.cfg.stopLoss > 0 && this.stats.profit <= -this.cfg.stopLoss) {
      this.stop(`Stop loss reached (${this.stats.profit.toFixed(2)})`);
    }
  }

  resetStats() {
    this.stats = emptyStats(this.baseStake);
    this.stats.activeContract = this.cfg.selected[0] ?? null;
    this.currentStake = this.baseStake;
    this.push();
  }
}
