import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BadgeCheck,
  Download,
  Eraser,
  Gauge,
  KeyRound,
  Loader2,
  Menu,
  Play,
  ShieldCheck,
  Sparkles,
  Square,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useInstallApp } from "@/hooks/use-install-app";
import { authorizeDeriv, roundStake, type DerivWS } from "@/lib/deriv";
import { BotEngine, type LogEntry, type Stats, type TradeState } from "@/lib/botEngine";
import {
  CONTRACTS,
  MARKETS,
  RECOMMENDED,
  SWITCH_MODES,
  type ContractDefId,
  type SwitchMode,
} from "@/lib/contracts";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Low Risker — Low-Risk Deriv Auto Trader" },
      {
        name: "description",
        content:
          "Connect your Deriv token, pick low-risk digit contracts and run them with martingale, take profit, stop loss and automatic contract switching.",
      },
      { property: "og:title", content: "Low Risker — Low-Risk Deriv Auto Trader" },
      {
        property: "og:description",
        content:
          "Low-risk Deriv digit trading with martingale rounding, take profit, stop loss, every-tick mode and live logs.",
      },
    ],
  }),
  component: LowRisker,
});

const emptyStats: Stats = {
  runs: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  currentStake: 0,
  consecutiveWins: 0,
  consecutiveLosses: 0,
  activeContract: null,
  tradesOnContract: 0,
};

function LowRisker() {
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [account, setAccount] = useState<{ loginid: string; currency: string; mode: string } | null>(null);
  const [balance, setBalance] = useState<number | null>(null);

  const [symbol, setSymbol] = useState(RECOMMENDED.symbol);
  const [stake, setStake] = useState(RECOMMENDED.stake);
  const [martingale, setMartingale] = useState(RECOMMENDED.martingale);
  const [takeProfit, setTakeProfit] = useState(RECOMMENDED.takeProfit);
  const [stopLoss, setStopLoss] = useState(RECOMMENDED.stopLoss);
  const [everyTick, setEveryTick] = useState(RECOMMENDED.speed === "tick");
  const [selected, setSelected] = useState<ContractDefId[]>(RECOMMENDED.selected);
  const [barriers, setBarriers] = useState<Record<ContractDefId, number>>({ ...RECOMMENDED.barriers });
  const [durations, setDurations] = useState<Record<ContractDefId, number>>({ ...RECOMMENDED.durations });
  const [multipliers, setMultipliers] = useState<Record<ContractDefId, number>>({ ...RECOMMENDED.multipliers });
  const [switchMode, setSwitchMode] = useState<SwitchMode>(RECOMMENDED.switchMode);
  const [switchValue, setSwitchValue] = useState(RECOMMENDED.switchValue);

  const [running, setRunning] = useState(false);
  const [tradeState, setTradeState] = useState<TradeState>("idle");
  const [stats, setStats] = useState<Stats>(emptyStats);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [price, setPrice] = useState("—");
  const [digits, setDigits] = useState<number[]>([]);

  const wsRef = useRef<DerivWS | null>(null);
  const engineRef = useRef<BotEngine | null>(null);
  const logId = useRef(1);

  const { canInstall, installed, install } = useInstallApp();

  const addLog = useCallback((level: LogEntry["level"], message: string) => {
    setLogs((prev) =>
      [
        ...prev,
        {
          id: logId.current++,
          time: new Date().toLocaleTimeString(),
          level,
          message,
        },
      ].slice(-300),
    );
  }, []);

  const cfg = useMemo(
    () => ({
      symbol,
      stake: roundStake(parseFloat(stake) || 0.35),
      martingale: parseFloat(martingale) || 1,
      takeProfit: parseFloat(takeProfit) || 0,
      stopLoss: parseFloat(stopLoss) || 0,
      speed: (everyTick ? "tick" : "normal") as "tick" | "normal",
      selected,
      barriers,
      durations,
      multipliers,
      switchMode,
      switchValue: parseInt(switchValue, 10) || 1,
    }),
    [
      symbol,
      stake,
      martingale,
      takeProfit,
      stopLoss,
      everyTick,
      selected,
      barriers,
      durations,
      multipliers,
      switchMode,
      switchValue,
    ],
  );

  useEffect(() => {
    engineRef.current?.updateConfig(cfg);
  }, [cfg]);

  useEffect(() => {
    return () => {
      engineRef.current?.stop("Session ended");
      wsRef.current?.close();
    };
  }, []);

  const handleConnect = async () => {
    if (!token.trim()) {
      toast.error("Paste your Deriv API token first");
      return;
    }
    setConnecting(true);
    addLog("info", "Connecting to Deriv…");
    try {
      const auth = await authorizeDeriv(token);
      wsRef.current = auth.ws;
      setConnected(true);
      setAccount({ loginid: auth.loginid, currency: auth.currency, mode: auth.mode });
      setBalance(auth.balance);
      addLog("info", `Connected as ${auth.loginid} (${auth.mode.toUpperCase()}) — balance ${auth.balance.toFixed(2)} ${auth.currency}`);
      toast.success(`Connected — ${auth.loginid}`);

      const engine = new BotEngine(auth.ws, cfg, auth.currency, {
        onLog: addLog,
        onStats: setStats,
        onTick: (digit, p) => {
          setPrice(p);
          setDigits((prev) => [...prev, digit].slice(-40));
        },
        onState: setTradeState,
        onStopped: () => setRunning(false),
        onBalance: setBalance,
      });
      engineRef.current = engine;
      engine.attachTicks();

      if (auth.mode === "legacy") {
        try {
          auth.ws.subscribe({ balance: 1 }, (data) => {
            const b = data?.balance?.balance;
            if (b !== undefined) setBalance(Number(b));
          });
        } catch {
          /* balance stream optional */
        }
      }

      auth.ws.onClose = () => {
        setConnected(false);
        setRunning(false);
        addLog("error", "Deriv connection closed");
      };
    } catch (error: any) {
      addLog("error", error?.message || "Could not connect");
      toast.error(error?.message || "Could not connect");
    } finally {
      setConnecting(false);
    }
  };

  const toggleContract = (id: ContractDefId) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  };

  const applyRecommended = () => {
    setSymbol(RECOMMENDED.symbol);
    setStake(RECOMMENDED.stake);
    setMartingale(RECOMMENDED.martingale);
    setTakeProfit(RECOMMENDED.takeProfit);
    setStopLoss(RECOMMENDED.stopLoss);
    setEveryTick(RECOMMENDED.speed === "tick");
    setSelected(RECOMMENDED.selected);
    setBarriers({ ...RECOMMENDED.barriers });
    setDurations({ ...RECOMMENDED.durations });
    setMultipliers({ ...RECOMMENDED.multipliers });
    setSwitchMode(RECOMMENDED.switchMode);
    setSwitchValue(RECOMMENDED.switchValue);
    toast.success("Recommended low-risk settings applied");
    addLog("info", "Recommended settings applied");
  };

  const start = () => {
    const engine = engineRef.current;
    if (!engine) {
      toast.error("Connect your account first");
      return;
    }
    engine.updateConfig(cfg);
    engine.start();
    setRunning(engine.isRunning);
  };

  const stop = () => {
    engineRef.current?.stop("Stopped by you");
    setRunning(false);
  };

  const winRate = stats.runs ? Math.round((stats.wins / stats.runs) * 100) : 0;
  const activeDef = CONTRACTS.find((c) => c.id === stats.activeContract);
  const needsValue = SWITCH_MODES.find((m) => m.id === switchMode)?.needsValue;

  return (
    <div className="min-h-screen bg-background pb-16">
      <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open menu">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[300px] bg-sidebar p-0">
              <SheetHeader className="border-b border-sidebar-border px-5 py-4 text-left">
                <SheetTitle className="flex items-center gap-2">
                  <ShieldCheck className="size-5 text-primary" />
                  Low Risker
                </SheetTitle>
                <SheetDescription>Low-risk automated trading on Deriv.</SheetDescription>
              </SheetHeader>
              <div className="space-y-5 px-5 py-5">
                <div className="space-y-1 text-sm">
                  <p className="text-muted-foreground">Account</p>
                  <p className="numeric font-semibold">{account?.loginid ?? "Not connected"}</p>
                  {balance !== null && (
                    <p className="numeric text-primary">
                      {balance.toFixed(2)} {account?.currency}
                    </p>
                  )}
                </div>
                <Separator />
                <div className="space-y-2">
                  <Button className="w-full" onClick={() => void install()} disabled={installed || !canInstall}>
                    <Download className="size-4" />
                    {installed ? "App installed" : "Install app"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {installed
                      ? "Launch it from your home screen — it opens full screen, without browser bars."
                      : canInstall
                        ? "Adds Low Risker to your home screen and opens it full screen."
                        : "On iPhone use Share → Add to Home Screen. On Android open the browser menu → Install app."}
                  </p>
                </div>
                <Separator />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Trading involves real money. Every digit contract risks the full stake, so keep stakes small and
                  always set a stop loss.
                </p>
              </div>
            </SheetContent>
          </Sheet>

          <div className="flex items-center gap-2">
            <img src="/icons/icon-192.png" alt="Low Risker" className="size-8 rounded-lg" width={192} height={192} />
            <div>
              <h1 className="text-base font-semibold leading-none">Low Risker</h1>
              <p className="text-[11px] text-muted-foreground">Deriv low-risk auto trader</p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <span
              className={cn(
                "size-2 rounded-full",
                connected ? "bg-primary shadow-[0_0_10px_2px_var(--color-primary)]" : "bg-muted-foreground",
              )}
            />
            <span className="text-xs text-muted-foreground">{connected ? "Live" : "Offline"}</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-4">
        {/* Connect */}
        <Card className="gap-3 p-4">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Connect account</h2>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              type="password"
              inputMode="text"
              autoComplete="off"
              placeholder="Deriv API token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <Button onClick={() => void handleConnect()} disabled={connecting}>
              {connecting ? <Loader2 className="size-4 animate-spin" /> : <BadgeCheck className="size-4" />}
              {connected ? "Reconnect" : "Connect"}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3 pt-1">
            <div className="rounded-lg bg-secondary p-3">
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Wallet className="size-3" /> Balance
              </p>
              <p className="numeric text-lg font-semibold text-primary">
                {balance === null ? "—" : `${balance.toFixed(2)} ${account?.currency ?? ""}`}
              </p>
            </div>
            <div className="rounded-lg bg-secondary p-3">
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Activity className="size-3" /> Last price
              </p>
              <p className="numeric text-lg font-semibold">{price}</p>
            </div>
          </div>
          {digits.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {digits.slice(-20).map((d, i) => (
                <span
                  key={i}
                  className="numeric flex size-6 items-center justify-center rounded-md bg-muted text-xs text-foreground"
                >
                  {d}
                </span>
              ))}
            </div>
          )}
        </Card>

        {/* Money management */}
        <Card className="gap-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Money management</h2>
            <Button size="sm" variant="secondary" onClick={applyRecommended}>
              <Sparkles className="size-4" />
              Recommended settings
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Stake" value={stake} onChange={setStake} step="0.01" />
            <Field label="Martingale ×" value={martingale} onChange={setMartingale} step="0.1" />
            <Field label="Take profit" value={takeProfit} onChange={setTakeProfit} step="0.1" />
            <Field label="Stop loss" value={stopLoss} onChange={setStopLoss} step="0.1" />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Stakes are always rounded to 2 decimals — next stake after a loss:{" "}
            <span className="numeric text-foreground">
              {roundStake((parseFloat(stake) || 0) * (parseFloat(martingale) || 1)).toFixed(2)}
            </span>
          </p>
          <Separator />
          <div className="space-y-2">
            <Label>Market</Label>
            <Select value={symbol} onValueChange={setSymbol}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MARKETS.map((m) => (
                  <SelectItem key={m.symbol} value={m.symbol}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-secondary p-3">
            <div className="pr-3">
              <p className="flex items-center gap-1 text-sm font-medium">
                <Gauge className="size-4 text-primary" /> Every tick mode
              </p>
              <p className="text-[11px] text-muted-foreground">
                {everyTick
                  ? "Trades on every tick and settles on the next one."
                  : "Normal speed — waits for each contract to settle completely."}
              </p>
            </div>
            <Switch checked={everyTick} onCheckedChange={setEveryTick} />
          </div>
        </Card>

        {/* Contracts */}
        <Card className="gap-3 p-4">
          <h2 className="text-sm font-semibold">Low-risk contracts</h2>
          <p className="text-[11px] text-muted-foreground">
            Only Deriv's lowest-risk trades are available — high-probability digits, barrier-free Rise/Fall, Reset
            contracts and capped-loss Multipliers. Every control already starts on its safest setting.
          </p>
          <div className="space-y-2">
            {CONTRACTS.map((c) => {
              const on = selected.includes(c.id);
              return (
                <div
                  key={c.id}
                  className={cn(
                    "rounded-xl border p-3 transition-colors",
                    on ? "border-primary bg-primary/5" : "border-border bg-secondary/40",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => toggleContract(c.id)}
                      className="flex-1 text-left"
                      aria-pressed={on}
                    >
                      <p className="flex items-center gap-2 text-sm font-semibold">
                        {c.name}
                        <Badge variant="secondary" className="numeric">
                          {Math.round(c.winRate * 100)}%
                        </Badge>
                      </p>
                      <p className="text-[11px] text-muted-foreground">{c.wins}</p>
                    </button>
                    <Switch checked={on} onCheckedChange={() => toggleContract(c.id)} />
                  </div>
                  {on && (
                    <div className="mt-3 space-y-3 border-t border-border pt-3">
                      {c.barrier && (
                        <OptionRow
                          label={c.barrier.label}
                          options={c.barrier.options}
                          safest={c.barrier.safest}
                          value={barriers[c.id]}
                          onSelect={(v) => setBarriers((prev) => ({ ...prev, [c.id]: v }))}
                        />
                      )}
                      {c.duration && (
                        <OptionRow
                          label={c.duration.label}
                          options={c.duration.options}
                          safest={c.duration.safest}
                          value={durations[c.id]}
                          onSelect={(v) => setDurations((prev) => ({ ...prev, [c.id]: v }))}
                        />
                      )}
                      {c.multiplier && (
                        <OptionRow
                          label={c.multiplier.label}
                          options={c.multiplier.options}
                          safest={c.multiplier.safest}
                          value={multipliers[c.id]}
                          onSelect={(v) => setMultipliers((prev) => ({ ...prev, [c.id]: v }))}
                          prefix="x"
                        />
                      )}
                      {!c.barrier && !c.duration && !c.multiplier && (
                        <p className="text-[11px] text-muted-foreground">No extra settings needed.</p>
                      )}
                      <p className="text-[11px] text-muted-foreground">{c.note}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <Separator />
          <div className="space-y-2">
            <Label>Switch between contracts</Label>
            <Select value={switchMode} onValueChange={(v) => setSwitchMode(v as SwitchMode)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SWITCH_MODES.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {SWITCH_MODES.find((m) => m.id === switchMode)?.hint}
            </p>
            {needsValue && (
              <Field label="X value" value={switchValue} onChange={setSwitchValue} step="1" />
            )}
          </div>
        </Card>

        {/* Controls */}
        <div className="grid grid-cols-2 gap-3">
          <Button size="lg" onClick={start} disabled={!connected || running || !selected.length}>
            <Play className="size-4" /> Start
          </Button>
          <Button size="lg" variant="destructive" onClick={stop} disabled={!running}>
            <Square className="size-4" /> Stop
          </Button>
        </div>

        {/* Stats */}
        <Card className="gap-3 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Stats</h2>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                engineRef.current?.resetStats();
                setStats(emptyStats);
              }}
            >
              <Eraser className="size-4" /> Clear
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Trades" value={String(stats.runs)} />
            <Stat label="Wins" value={String(stats.wins)} tone="success" />
            <Stat label="Losses" value={String(stats.losses)} tone="destructive" />
            <Stat label="Win rate" value={`${winRate}%`} />
            <Stat
              label="Profit"
              value={`${stats.profit >= 0 ? "+" : ""}${stats.profit.toFixed(2)}`}
              tone={stats.profit >= 0 ? "success" : "destructive"}
            />
            <Stat label="Next stake" value={stats.currentStake.toFixed(2)} />
            <Stat label="Win streak" value={String(stats.consecutiveWins)} />
            <Stat label="Loss streak" value={String(stats.consecutiveLosses)} />
            <Stat label="Status" value={running ? tradeState : "stopped"} />
          </div>
          {activeDef && (
            <p className="text-[11px] text-muted-foreground">
              Trading <span className="text-foreground">{activeDef.name}</span>{" "}
              <span className="numeric text-foreground">
                {activeDef.barrier
                  ? `barrier ${barriers[activeDef.id]}`
                  : activeDef.multiplier
                    ? `x${multipliers[activeDef.id]}`
                    : `${durations[activeDef.id]} ticks`}
              </span> — {stats.tradesOnContract} trade
              {stats.tradesOnContract === 1 ? "" : "s"} on this contract
            </p>
          )}
        </Card>

        {/* Logs */}
        <Card className="gap-3 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Log</h2>
            <Button size="sm" variant="ghost" onClick={() => setLogs([])}>
              <Eraser className="size-4" /> Clear
            </Button>
          </div>
          <ScrollArea className="h-64 rounded-lg bg-background/60 p-2">
            {logs.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">Nothing yet — connect and start trading.</p>
            ) : (
              <div className="space-y-1">
                {[...logs].reverse().map((l) => (
                  <p key={l.id} className="numeric text-[11px] leading-relaxed">
                    <span className="text-muted-foreground">{l.time} </span>
                    <span
                      className={cn(
                        l.level === "win" && "text-success",
                        l.level === "loss" && "text-destructive",
                        l.level === "error" && "text-destructive",
                        l.level === "info" && "text-foreground",
                      )}
                    >
                      {l.message}
                    </span>
                  </p>
                ))}
              </div>
            )}
          </ScrollArea>
        </Card>
      </main>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  step: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px]">{label}</Label>
      <Input
        type="number"
        inputMode="decimal"
        step={step}
        min="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="numeric"
      />
    </div>
  );
}

function OptionRow({
  label,
  options,
  safest,
  value,
  onSelect,
  prefix = "",
}: {
  label: string;
  options: number[];
  safest: number;
  value: number;
  onSelect: (v: number) => void;
  prefix?: string;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-[11px]">{label}</Label>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onSelect(o)}
            className={cn(
              "numeric h-9 min-w-9 rounded-lg border px-2 text-sm transition-colors",
              value === o
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-foreground",
            )}
          >
            {prefix}
            {o}
          </button>
        ))}
        {value === safest && <Badge className="self-center bg-success text-success-foreground">Safest</Badge>}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "success" | "destructive" }) {
  return (
    <div className="rounded-lg bg-secondary p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          "numeric text-sm font-semibold",
          tone === "success" && "text-success",
          tone === "destructive" && "text-destructive",
        )}
      >
        {value}
      </p>
    </div>
  );
}
