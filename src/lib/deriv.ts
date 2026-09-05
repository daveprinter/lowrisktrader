export const DERIV_LEGACY_APP_ID = "1089";

// PAT tokens use Deriv's new PAT-format App ID.
export const DERIV_NEW_APP_ID = "33uaaVh8xkm8lpUWTHDkm";

const DERIV_LEGACY_WS = `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_LEGACY_APP_ID}`;

const DERIV_REST_BASE = "https://api.derivws.com/trading/v1/options";

export type DerivMode = "legacy" | "pat";

export type DerivAuthResult = {
  ws: DerivWS;
  loginid: string;
  currency: string;
  balance: number;
  mode: DerivMode;
};

export function detectTokenMode(token: string): DerivMode {
  const t = token.trim();
  // Legacy API tokens are short (typically 15 chars) and often prefixed "a1-".
  if (/^a1-/i.test(t)) return "legacy";
  if (t.length <= 32 && !t.includes(".")) return "legacy";
  return "pat";
}

export function extractDerivRestError(body: any, fallback: string): string {
  if (!body) return fallback;
  const e = body.error || body.errors?.[0] || body;
  return e?.message || e?.detail || e?.code || fallback;
}

async function derivRest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${DERIV_REST_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Deriv-App-ID": DERIV_NEW_APP_ID,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
  } catch (error: any) {
    throw new Error(error?.message || "Could not reach Deriv PAT API");
  }

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    /* ignore */
  }

  if (!response.ok) {
    throw new Error(extractDerivRestError(body, `Deriv PAT API failed (${response.status})`));
  }

  return body as T;
}

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
};

export class DerivWS {
  mode: DerivMode = "legacy";
  private socket: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, Pending>();
  private subs = new Map<number, (data: any) => void>();
  onClose: (() => void) | null = null;

  get isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(url?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url || DERIV_LEGACY_WS);
      } catch (e: any) {
        reject(new Error(e?.message || "Could not open WebSocket"));
        return;
      }
      this.socket = socket;

      const timer = setTimeout(() => {
        reject(new Error("Deriv connection timed out"));
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }, 20000);

      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("WebSocket connection failed"));
      };
      socket.onclose = () => {
        for (const [, p] of this.pending) p.reject(new Error("Connection closed"));
        this.pending.clear();
        this.subs.clear();
        this.onClose?.();
      };
      socket.onmessage = (event) => this.handleMessage(event);
    });
  }

  private handleMessage(event: MessageEvent) {
    let data: any;
    try {
      data = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const id = Number(data?.req_id);

    const sub = this.subs.get(id);
    if (sub) {
      if (data?.error) {
        // surface subscription errors through the handler
        sub(data);
      } else {
        sub(data);
      }
    }

    const p = this.pending.get(id);
    if (p) {
      this.pending.delete(id);
      if (data?.error) p.reject(new Error(data.error.message || data.error.code || "Deriv error"));
      else p.resolve(data);
    }
  }

  send<T = any>(payload: Record<string, any>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.isOpen) {
        reject(new Error("Not connected to Deriv"));
        return;
      }
      const req_id = this.reqId++;
      this.pending.set(req_id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.has(req_id)) {
          this.pending.delete(req_id);
          reject(new Error("Deriv request timed out"));
        }
      }, 30000);
      const wrapped: Pending = {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.pending.set(req_id, wrapped);
      this.socket!.send(JSON.stringify({ ...payload, req_id }));
    });
  }

  subscribe(payload: Record<string, any>, handler: (data: any) => void): number {
    if (!this.isOpen) throw new Error("Not connected to Deriv");
    const req_id = this.reqId++;
    this.subs.set(req_id, handler);
    this.socket!.send(JSON.stringify({ ...payload, subscribe: 1, req_id }));
    return req_id;
  }

  unsubscribeAll() {
    this.subs.clear();
    if (this.isOpen) {
      try {
        this.socket!.send(JSON.stringify({ forget_all: ["ticks", "proposal_open_contract", "balance"] }));
      } catch {
        /* ignore */
      }
    }
  }

  close() {
    this.subs.clear();
    this.pending.clear();
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}

export async function authorizeDeriv(rawToken: string): Promise<DerivAuthResult> {
  const token = rawToken.trim();

  if (!token) throw new Error("Empty token");

  const mode = detectTokenMode(token);

  // ==================== LEGACY ====================
  if (mode === "legacy") {
    const ws = new DerivWS();
    ws.mode = "legacy";
    await ws.connect();

    const auth = await ws.send<any>({ authorize: token });

    if (!auth?.authorize) {
      throw new Error("Invalid token (legacy)");
    }

    return {
      ws,
      loginid: auth.authorize.loginid,
      currency: auth.authorize.currency || "USD",
      balance: Number(auth.authorize.balance ?? 0),
      mode,
    };
  }

  // ==================== PAT ====================

  // Step 1: Get accounts list via REST
  const accountsResponse = await derivRest<{ data?: any[] | any }>("/accounts", token, {
    method: "GET",
  });

  const accounts = Array.isArray(accountsResponse.data)
    ? accountsResponse.data
    : accountsResponse.data
      ? [accountsResponse.data]
      : [];

  const account = accounts.find((a) => a?.status === "active") || accounts[0];

  const accountId = String(account?.account_id || account?.id || account?.loginid || "");

  if (!accountId) {
    throw new Error("No Deriv options account found for this PAT token");
  }

  // Step 2: Request OTP to get an authenticated WebSocket URL
  const otpResponse = await derivRest<{ data?: { url?: string; websocket_url?: string } }>(
    `/accounts/${encodeURIComponent(accountId)}/otp`,
    token,
    { method: "POST" },
  );

  const websocketUrl = String(otpResponse.data?.url || otpResponse.data?.websocket_url || "");

  if (!websocketUrl) {
    throw new Error("Deriv PAT API did not return a WebSocket URL");
  }

  // Step 3: Connect directly using authenticated URL
  const ws = new DerivWS();
  ws.mode = "pat";
  await ws.connect(websocketUrl);

  // Values come from the REST account object.
  const balance = Number(account?.balance ?? 0);
  const currency = String(account?.currency ?? "USD");
  const loginid = accountId;

  return { ws, loginid, currency, balance, mode };
}

/** Deriv only accepts stakes with at most 2 decimal places. */
export function roundStake(value: number): number {
  return Math.round(value * 100) / 100;
}
