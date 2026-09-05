import { DerivWS, roundStake } from "./deriv";
import { CONTRACTS, DEFAULT_DURATIONS, DEFAULT_MULTIPLIERS, type ContractDefId, type SwitchMode } from "./contracts";

export type SpeedMode = "tick" | "normal";
export type TradeState = "idle" | "buying" | "awaiting";

export type BotConfig = {
  symbol: string;
  stake: number;
  martingale: number;
  takeProfit: number;
  stopLoss: number;
  speed: SpeedMode;
  selected: ContractDefId[];
  barriers: Record<ContractDefId, number>;
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
    buyPrice: number;
    payout: number;
    type: string;
    barrier: number;
    contractId?: number | undefined;
  } | null = null;

  private stats: Stats;
  private baseStake: number;
  private currentStake: number;
  private contractIndex = 0;
  private digits: number[] = [];

  constructor(ws: DerivWS, cfg: BotConfig, currency: string, ev: BotEvents) {
    this.ws = ws;
    this.cfg = cfg;
    this.ev = ev;
    this.currency = currency;
    this.baseStake = roundStake(cfg.stake);
    this.currentStake = this.baseStake;
    this.stats = emptyStats(this.baseStake);
    this.stats.activeContract = cfg.selected[0] ?? null;
  }

  updateConfig(cfg: Partial<BotConfig>) {
    this.cfg = { ...this.cfg, ...cfg };
    if (cfg.stake !== undefined) {
      this.baseStake = roundStake(cfg.stake);
      if (!this.running) {
        this.currentStake = this.baseStake;
        this.stats.currentStake = this.baseStake;
        this.push();
      }
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

  /** Subscribe to the tick stream. Safe to call once per connection. */
  attachTicks() {
    this.ws.subscribe(
      this.ws.mode === "pat"
        ? { ticks: this.cfg.symbol, underlying_symbol: this.cfg.symbol }
        : { ticks: this.cfg.symbol },
      (data) => {
        if (data?.error) {
          this.ev.onLog("error", data.error.message || "Tick stream error");
          return;
        }
        const tick = data?.tick;
        if (!tick) return;
        this.handleTick(tick);
      },
    );
  }

  start() {
    if (this.running) return;
    if (!this.cfg.selected.length) {
      this.ev.onLog("error", "Pick at least one contract first.");
      return;
    }
    this.running = true;
    this.currentStake = this.baseStake;
    this.stats.currentStake = this.baseStake;
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
    this.ev.onLog("info", `Switched to ${this.activeDef().name}`);
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

    // Settle pending trade on THIS tick (every-tick mode settles locally)
    if (this.cfg.speed === "tick" && this.tradeState === "awaiting" && this.pending) {
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
    const barrier = this.cfg.barriers[def.id] ?? def.barrier.safest;

    this.setState("buying");

    const contractParams: Record<string, any> = {
      amount: stake,
      basis: "stake",
      contract_type: def.type,
      currency: this.currency || "USD",
      duration: 1,
      duration_unit: "t",
      barrier: String(barrier),
    };

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

      this.pending = { buyPrice, payout, type: def.type, barrier, contractId };
      this.setState("awaiting");
      this.ev.onLog("info", `Bought ${def.short} ${barrier} — stake ${buyPrice.toFixed(2)}`);

      if (this.cfg.speed === "normal") this.watchContract();
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
