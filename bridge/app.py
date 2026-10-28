"""
MT5 Bridge — small HTTP API in front of the MetaTrader 5 terminal.

Runs on the Windows machine where the MT5 terminal is installed and logged in.
The Node bot (on Linux) calls this API for prices, candles, account info and orders.

Start:  python -m uvicorn app:app --host 0.0.0.0 --port 8765
Mock:   BRIDGE_MOCK=1 python -m uvicorn app:app --port 8765   (no MT5 needed; for testing on Linux/CI)
"""

from __future__ import annotations

import hmac
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from pydantic import BaseModel, Field

try:  # load bridge/.env when present
    from dotenv import load_dotenv

    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except Exception:  # pragma: no cover
    pass

MOCK = os.getenv("BRIDGE_MOCK", "0") == "1"

if MOCK:
    import mock_mt5 as mt5  # type: ignore
else:  # pragma: no cover - only on Windows
    import MetaTrader5 as mt5  # type: ignore

logging.basicConfig(
    level=os.getenv("BRIDGE_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("mt5-bridge")

BRIDGE_TOKEN = os.getenv("BRIDGE_TOKEN", "")
MT5_LOGIN = int(os.getenv("MT5_LOGIN", "0") or 0)
MT5_PASSWORD = os.getenv("MT5_PASSWORD", "")
MT5_SERVER = os.getenv("MT5_SERVER", "")
MT5_PATH = os.getenv("MT5_PATH", "") or None
ALLOWED_SYMBOLS = {s.strip().upper() for s in os.getenv("ALLOWED_SYMBOLS", "XAUUSD").split(",") if s.strip()}
DEFAULT_MAGIC = int(os.getenv("MT5_MAGIC", "260101"))

TIMEFRAMES = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
}
TF_SECONDS = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H4": 14400, "D1": 86400}

# The MetaTrader5 package is not thread-safe; FastAPI runs sync endpoints in a thread pool.
_lock = threading.RLock()
_last_init_attempt = 0.0

@asynccontextmanager
async def lifespan(_: FastAPI):
    if not BRIDGE_TOKEN:
        log.warning("BRIDGE_TOKEN is empty — every authenticated call will fail")
    with _lock:
        _connect()
    yield
    with _lock:
        mt5.shutdown()


app = FastAPI(title="MT5 Bridge", version="1.0.0", lifespan=lifespan)


# --------------------------------------------------------------------------- helpers


def require_token(authorization: str = Header(default="")) -> None:
    if not BRIDGE_TOKEN:
        raise HTTPException(500, "BRIDGE_TOKEN is not set on the bridge")
    expected = f"Bearer {BRIDGE_TOKEN}"
    if not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise HTTPException(401, "Unauthorized")


def _connect() -> bool:
    """Initialize / re-initialize the MT5 connection. Caller holds the lock."""
    global _last_init_attempt
    info = mt5.terminal_info()
    acc = mt5.account_info()
    if info is not None and acc is not None and (not MT5_LOGIN or acc.login == MT5_LOGIN):
        return True

    # Avoid hammering the terminal when it is down.
    if time.time() - _last_init_attempt < 5:
        return False
    _last_init_attempt = time.time()

    kwargs: Dict[str, Any] = {}
    if MT5_PATH:
        kwargs["path"] = MT5_PATH
    if MT5_LOGIN:
        kwargs.update(login=MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER)

    mt5.shutdown()
    ok = mt5.initialize(**kwargs)
    if not ok:
        log.error("MT5 initialize failed: %s", mt5.last_error())
        return False
    acc = mt5.account_info()
    log.info("MT5 connected: login=%s server=%s", getattr(acc, "login", "?"), getattr(acc, "server", "?"))
    return True


def ensure_connected() -> None:
    if not _connect():
        raise HTTPException(503, f"MT5 not connected: {mt5.last_error()}")


def check_symbol(symbol: str) -> str:
    sym = symbol.upper()
    if sym not in ALLOWED_SYMBOLS:
        raise HTTPException(400, f"Symbol {sym} not allowed (ALLOWED_SYMBOLS={','.join(sorted(ALLOWED_SYMBOLS))})")
    if not mt5.symbol_select(sym, True):
        raise HTTPException(404, f"Symbol {sym} not available in terminal")
    return sym


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def position_dict(p: Any) -> Dict[str, Any]:
    return {
        "ticket": int(p.ticket),
        "symbol": p.symbol,
        "side": "BUY" if p.type == mt5.POSITION_TYPE_BUY else "SELL",
        "volume": float(p.volume),
        "priceOpen": float(p.price_open),
        "priceCurrent": float(p.price_current),
        "sl": float(p.sl),
        "tp": float(p.tp),
        "profit": float(p.profit),
        "swap": float(p.swap),
        "magic": int(p.magic),
        "comment": p.comment,
        "time": iso(p.time),
    }


def filling_mode(symbol_info: Any) -> int:
    """Pick a filling mode the symbol supports (brokers differ)."""
    modes = int(getattr(symbol_info, "filling_mode", 0))
    if modes & 1:  # SYMBOL_FILLING_FOK
        return mt5.ORDER_FILLING_FOK
    if modes & 2:  # SYMBOL_FILLING_IOC
        return mt5.ORDER_FILLING_IOC
    return mt5.ORDER_FILLING_RETURN


def order_result(result: Any) -> Dict[str, Any]:
    if result is None:
        raise HTTPException(502, f"order_send returned None: {mt5.last_error()}")
    data = {
        "retcode": int(result.retcode),
        "comment": result.comment,
        "order": int(result.order),
        "deal": int(result.deal),
        "volume": float(result.volume),
        "price": float(result.price),
    }
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        raise HTTPException(422, {"message": f"Order rejected: {result.comment}", **data})
    return data


# --------------------------------------------------------------------------- models


class OrderRequest(BaseModel):
    symbol: str
    side: Literal["BUY", "SELL"]
    volume: float = Field(gt=0)
    sl: float = Field(gt=0)
    tp: float = Field(gt=0)
    deviation: int = Field(default=20, ge=0, le=500)
    magic: int = DEFAULT_MAGIC
    comment: str = Field(default="fn-bot", max_length=25)


class CloseRequest(BaseModel):
    ticket: int
    volume: Optional[float] = None
    deviation: int = Field(default=20, ge=0, le=500)


class ModifyRequest(BaseModel):
    ticket: int
    sl: float = Field(gt=0)
    tp: float = Field(gt=0)


# --------------------------------------------------------------------------- routes


@app.get("/health")
def health() -> Dict[str, Any]:
    """Unauthenticated liveness check (no account data)."""
    with _lock:
        connected = _connect()
        info = mt5.terminal_info() if connected else None
        return {
            "ok": connected,
            "mock": MOCK,
            "tradeAllowed": bool(getattr(info, "trade_allowed", False)) if info else False,
            "time": datetime.now(timezone.utc).isoformat(),
        }


@app.get("/account", dependencies=[Depends(require_token)])
def account() -> Dict[str, Any]:
    with _lock:
        ensure_connected()
        a = mt5.account_info()
        info = mt5.terminal_info()
        return {
            "login": int(a.login),
            "server": a.server,
            "currency": a.currency,
            "balance": float(a.balance),
            "equity": float(a.equity),
            "margin": float(a.margin),
            "freeMargin": float(a.margin_free),
            "leverage": int(a.leverage),
            "tradeAllowed": bool(getattr(info, "trade_allowed", False)),
        }


@app.get("/symbol/{symbol}", dependencies=[Depends(require_token)])
def symbol_spec(symbol: str) -> Dict[str, Any]:
    with _lock:
        ensure_connected()
        sym = check_symbol(symbol)
        s = mt5.symbol_info(sym)
        if s is None:
            raise HTTPException(404, f"No symbol info for {sym}")
        return {
            "symbol": sym,
            "digits": int(s.digits),
            "point": float(s.point),
            "contractSize": float(s.trade_contract_size),
            "volumeMin": float(s.volume_min),
            "volumeMax": float(s.volume_max),
            "volumeStep": float(s.volume_step),
            "stopsLevel": int(s.trade_stops_level),
            "spreadPoints": int(s.spread),
            "tickValue": float(s.trade_tick_value),
            "tickSize": float(s.trade_tick_size),
        }


@app.get("/tick/{symbol}", dependencies=[Depends(require_token)])
def tick(symbol: str) -> Dict[str, Any]:
    with _lock:
        ensure_connected()
        sym = check_symbol(symbol)
        t = mt5.symbol_info_tick(sym)
        if t is None or not t.bid:
            raise HTTPException(503, f"No tick for {sym}: {mt5.last_error()}")
        return {"symbol": sym, "bid": float(t.bid), "ask": float(t.ask), "time": iso(t.time)}


@app.get("/candles/{symbol}", dependencies=[Depends(require_token)])
def candles(
    symbol: str,
    timeframe: str = Query(default="H1"),
    count: int = Query(default=100, ge=1, le=10000),
    start: int = Query(default=0, ge=0, le=1_000_000),
) -> Dict[str, Any]:
    """Last `count` bars, skipping the newest `start` bars (start>0 pages back through history)."""
    tf = timeframe.upper()
    if tf not in TIMEFRAMES:
        raise HTTPException(400, f"Unsupported timeframe {timeframe}")
    with _lock:
        ensure_connected()
        sym = check_symbol(symbol)
        rates = mt5.copy_rates_from_pos(sym, TIMEFRAMES[tf], start, count)
        if rates is None:
            raise HTTPException(503, f"copy_rates failed: {mt5.last_error()}")
        t = mt5.symbol_info_tick(sym)
        server_now = float(t.time) if t is not None else time.time()

    out: List[Dict[str, Any]] = []
    for r in rates:
        start = float(r["time"])
        out.append(
            {
                # Bar times from MT5 are in *server* time encoded as epoch seconds.
                "time": iso(start),
                "open": float(r["open"]),
                "high": float(r["high"]),
                "low": float(r["low"]),
                "close": float(r["close"]),
                "volume": int(r["tick_volume"]),
                "closed": start + TF_SECONDS[tf] <= server_now,
            }
        )
    return {"symbol": sym, "timeframe": tf, "candles": out}


@app.get("/positions", dependencies=[Depends(require_token)])
def positions(symbol: Optional[str] = None, magic: Optional[int] = None) -> Dict[str, Any]:
    with _lock:
        ensure_connected()
        rows = mt5.positions_get(symbol=symbol.upper()) if symbol else mt5.positions_get()
        rows = rows or []
        out = [position_dict(p) for p in rows if magic is None or int(p.magic) == magic]
        return {"positions": out}


@app.post("/order", dependencies=[Depends(require_token)])
def place_order(req: OrderRequest) -> Dict[str, Any]:
    with _lock:
        ensure_connected()
        sym = check_symbol(req.symbol)
        info = mt5.symbol_info(sym)
        t = mt5.symbol_info_tick(sym)
        if info is None or t is None:
            raise HTTPException(503, "No symbol info / tick")
        price = t.ask if req.side == "BUY" else t.bid
        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": sym,
            "volume": float(req.volume),
            "type": mt5.ORDER_TYPE_BUY if req.side == "BUY" else mt5.ORDER_TYPE_SELL,
            "price": price,
            "sl": float(req.sl),
            "tp": float(req.tp),
            "deviation": req.deviation,
            "magic": req.magic,
            "comment": req.comment,
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": filling_mode(info),
        }
        log.info("order_send %s", request)
        result = order_result(mt5.order_send(request))
        # The position ticket equals the order ticket for market orders on netting/hedging accounts.
        result["ticket"] = result["order"]
        return result


@app.post("/close", dependencies=[Depends(require_token)])
def close_position(req: CloseRequest) -> Dict[str, Any]:
    with _lock:
        ensure_connected()
        rows = mt5.positions_get(ticket=req.ticket)
        if not rows:
            raise HTTPException(404, f"Position {req.ticket} not found")
        p = rows[0]
        t = mt5.symbol_info_tick(p.symbol)
        info = mt5.symbol_info(p.symbol)
        is_buy = p.type == mt5.POSITION_TYPE_BUY
        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": p.symbol,
            "volume": float(req.volume or p.volume),
            "type": mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY,
            "position": int(p.ticket),
            "price": t.bid if is_buy else t.ask,
            "deviation": req.deviation,
            "magic": int(p.magic),
            "comment": "fn-bot close",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": filling_mode(info),
        }
        log.info("close %s", request)
        return order_result(mt5.order_send(request))


@app.post("/modify", dependencies=[Depends(require_token)])
def modify_position(req: ModifyRequest) -> Dict[str, Any]:
    with _lock:
        ensure_connected()
        rows = mt5.positions_get(ticket=req.ticket)
        if not rows:
            raise HTTPException(404, f"Position {req.ticket} not found")
        p = rows[0]
        request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "symbol": p.symbol,
            "position": int(p.ticket),
            "sl": float(req.sl),
            "tp": float(req.tp),
        }
        return order_result(mt5.order_send(request))


@app.get("/history/position/{ticket}", dependencies=[Depends(require_token)])
def position_history(ticket: int, days: int = Query(default=14, ge=1, le=90)) -> Dict[str, Any]:
    """Deals of a (closed) position: realized P&L and the exit reason."""
    with _lock:
        ensure_connected()
        now = datetime.now(timezone.utc) + timedelta(days=1)
        deals = mt5.history_deals_get(now - timedelta(days=days), now, position=ticket) or []

    if not deals:
        return {"ticket": ticket, "closed": False, "deals": []}

    reason_names = {
        getattr(mt5, "DEAL_REASON_SL", 4): "STOP_LOSS",
        getattr(mt5, "DEAL_REASON_TP", 5): "TAKE_PROFIT",
        getattr(mt5, "DEAL_REASON_SO", 6): "STOP_OUT",
    }
    out_deals = []
    exit_price = None
    exit_reason = None
    exit_time = None
    profit = 0.0
    for d in deals:
        profit += float(d.profit) + float(d.commission) + float(d.swap) + float(getattr(d, "fee", 0.0))
        entry_out = d.entry in (mt5.DEAL_ENTRY_OUT, getattr(mt5, "DEAL_ENTRY_OUT_BY", 3))
        if entry_out:
            exit_price = float(d.price)
            exit_time = iso(d.time)
            exit_reason = reason_names.get(int(d.reason), "MANUAL_OR_BOT")
        out_deals.append(
            {
                "ticket": int(d.ticket),
                "entry": int(d.entry),
                "price": float(d.price),
                "volume": float(d.volume),
                "profit": float(d.profit),
                "commission": float(d.commission),
                "swap": float(d.swap),
                "reason": int(d.reason),
                "time": iso(d.time),
            }
        )
    return {
        "ticket": ticket,
        "closed": exit_price is not None,
        "exitPrice": exit_price,
        "exitReason": exit_reason,
        "exitTime": exit_time,
        "profit": round(profit, 2),
        "deals": out_deals,
    }


if MOCK:

    class MockPrice(BaseModel):
        price: float = Field(gt=0)

    @app.post("/mock/price", dependencies=[Depends(require_token)])
    def mock_set_price(req: MockPrice) -> Dict[str, Any]:
        """MOCK ONLY: jump the fake price (to test SL/TP handling end-to-end)."""
        mt5._set_price(req.price)
        return {"ok": True, "price": req.price}
