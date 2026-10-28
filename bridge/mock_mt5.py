"""
In-memory stand-in for the MetaTrader5 package (BRIDGE_MOCK=1).

Lets the bridge — and the Node bot's MT5 code paths — run on Linux / in CI
without a real terminal. Prices are a random walk; SL/TP are checked on every tick.
Only the functions and constants the bridge uses are implemented.
"""

from __future__ import annotations

import math
import random
import threading
import time
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

# ---- constants -------------------------------------------------------------
TIMEFRAME_M1, TIMEFRAME_M5, TIMEFRAME_M15, TIMEFRAME_M30 = 1, 5, 15, 30
TIMEFRAME_H1, TIMEFRAME_H4, TIMEFRAME_D1 = 16385, 16388, 16408
_TF_SECONDS = {1: 60, 5: 300, 15: 900, 30: 1800, 16385: 3600, 16388: 14400, 16408: 86400}

POSITION_TYPE_BUY, POSITION_TYPE_SELL = 0, 1
ORDER_TYPE_BUY, ORDER_TYPE_SELL = 0, 1
TRADE_ACTION_DEAL, TRADE_ACTION_SLTP = 1, 6
ORDER_TIME_GTC = 0
ORDER_FILLING_FOK, ORDER_FILLING_IOC, ORDER_FILLING_RETURN = 0, 1, 2
TRADE_RETCODE_DONE = 10009
TRADE_RETCODE_INVALID_STOPS = 10016
DEAL_ENTRY_IN, DEAL_ENTRY_OUT, DEAL_ENTRY_OUT_BY = 0, 1, 3
DEAL_REASON_CLIENT, DEAL_REASON_EXPERT, DEAL_REASON_SL, DEAL_REASON_TP, DEAL_REASON_SO = 0, 3, 4, 5, 6

_lock = threading.RLock()
_connected = False
_ticket = 1000
_price = 4000.0
_last_step = time.time()
_positions: Dict[int, SimpleNamespace] = {}
_deals: List[SimpleNamespace] = []
_balance = 6000.0
SPREAD = 0.30
CONTRACT = 100.0
VOL = float(__import__("os").getenv("MOCK_VOLATILITY", "1"))


def _next_ticket() -> int:
    global _ticket
    _ticket += 1
    return _ticket


def _step() -> None:
    """Advance the random walk and process SL/TP hits."""
    global _price, _last_step
    now = time.time()
    steps = min(int((now - _last_step) / 1.0), 600)
    if steps <= 0:
        return
    for _ in range(steps):
        _price += random.gauss(0, 0.35 * VOL)
    _last_step = now
    _process_stops()


def _process_stops() -> None:
    bid, ask = round(_price, 2), round(_price + SPREAD, 2)
    for p in list(_positions.values()):
        cur = bid if p.type == POSITION_TYPE_BUY else ask
        p.price_current = cur
        sign = 1 if p.type == POSITION_TYPE_BUY else -1
        p.profit = round((cur - p.price_open) * sign * p.volume * CONTRACT, 2)
        sl_hit = (cur <= p.sl) if p.type == POSITION_TYPE_BUY else (cur >= p.sl)
        tp_hit = (cur >= p.tp) if p.type == POSITION_TYPE_BUY else (cur <= p.tp)
        if sl_hit or tp_hit:
            price = p.sl if sl_hit else p.tp
            _close(p, price, DEAL_REASON_SL if sl_hit else DEAL_REASON_TP)


def _close(p: SimpleNamespace, price: float, reason: int) -> None:
    global _balance
    sign = 1 if p.type == POSITION_TYPE_BUY else -1
    profit = round((price - p.price_open) * sign * p.volume * CONTRACT, 2)
    _balance += profit
    _deals.append(
        SimpleNamespace(
            ticket=_next_ticket(), position_id=p.ticket, entry=DEAL_ENTRY_OUT, price=price, volume=p.volume,
            profit=profit, commission=0.0, swap=0.0, fee=0.0, reason=reason, time=int(time.time()),
        )
    )
    _positions.pop(p.ticket, None)


# ---- API -------------------------------------------------------------------
def initialize(**_: Any) -> bool:
    global _connected
    _connected = True
    return True


def shutdown() -> None:
    global _connected
    _connected = False


def last_error() -> tuple:
    return (1, "Success") if _connected else (-10004, "No IPC connection")


def terminal_info() -> Optional[SimpleNamespace]:
    return SimpleNamespace(trade_allowed=True, connected=True) if _connected else None


def account_info() -> Optional[SimpleNamespace]:
    if not _connected:
        return None
    with _lock:
        _step()
        floating = sum(p.profit for p in _positions.values())
        return SimpleNamespace(
            login=12345678, server="Mock-Server", currency="USD", balance=round(_balance, 2),
            equity=round(_balance + floating, 2), margin=0.0, margin_free=round(_balance + floating, 2), leverage=100,
        )


def symbol_select(symbol: str, enable: bool = True) -> bool:
    return symbol == "XAUUSD"


def symbol_info(symbol: str) -> Optional[SimpleNamespace]:
    if symbol != "XAUUSD":
        return None
    return SimpleNamespace(
        digits=2, point=0.01, trade_contract_size=CONTRACT, volume_min=0.01, volume_max=50.0, volume_step=0.01,
        trade_stops_level=0, spread=int(SPREAD * 100), trade_tick_value=1.0, trade_tick_size=0.01, filling_mode=2,
    )


def symbol_info_tick(symbol: str) -> Optional[SimpleNamespace]:
    if symbol != "XAUUSD":
        return None
    with _lock:
        _step()
        return SimpleNamespace(bid=round(_price, 2), ask=round(_price + SPREAD, 2), time=int(time.time()))


def copy_rates_from_pos(symbol: str, timeframe: int, start: int, count: int) -> List[Dict[str, Any]]:
    """Deterministic-ish synthetic history ending at the current price."""
    with _lock:
        _step()
        secs = _TF_SECONDS[timeframe]
        now = int(time.time())
        cur_start = now - now % secs - start * secs
        rng = random.Random(cur_start // secs)
        scale = 8.0 * math.sqrt(secs / 3600) * VOL
        bars: List[Dict[str, Any]] = []
        close = _price
        for i in range(count):
            t = cur_start - i * secs
            open_ = close - rng.gauss(0, scale)
            high = max(open_, close) + abs(rng.gauss(0, scale * 0.5))
            low = min(open_, close) - abs(rng.gauss(0, scale * 0.5))
            bars.append({"time": t, "open": round(open_, 2), "high": round(high, 2), "low": round(low, 2),
                         "close": round(close, 2), "tick_volume": 1000})
            close = open_
        bars.reverse()
        return bars


def positions_get(symbol: Optional[str] = None, ticket: Optional[int] = None) -> List[SimpleNamespace]:
    with _lock:
        _step()
        rows = list(_positions.values())
        if symbol:
            rows = [p for p in rows if p.symbol == symbol]
        if ticket is not None:
            rows = [p for p in rows if p.ticket == ticket]
        return rows


def order_send(request: Dict[str, Any]) -> SimpleNamespace:
    with _lock:
        _step()
        bid, ask = round(_price, 2), round(_price + SPREAD, 2)
        if request["action"] == TRADE_ACTION_SLTP:
            p = _positions.get(request["position"])
            if p:
                p.sl, p.tp = request["sl"], request["tp"]
            return SimpleNamespace(retcode=TRADE_RETCODE_DONE, comment="Done", order=0, deal=0, volume=0.0, price=0.0)

        if "position" in request:  # close
            p = _positions.get(request["position"])
            if not p:
                return SimpleNamespace(retcode=10013, comment="Position not found", order=0, deal=0, volume=0.0, price=0.0)
            price = bid if p.type == POSITION_TYPE_BUY else ask
            _close(p, price, DEAL_REASON_EXPERT)
            return SimpleNamespace(retcode=TRADE_RETCODE_DONE, comment="Done", order=_next_ticket(), deal=_next_ticket(),
                                   volume=p.volume, price=price)

        is_buy = request["type"] == ORDER_TYPE_BUY
        price = ask if is_buy else bid
        sl, tp = request["sl"], request["tp"]
        if (is_buy and not (sl < price < tp)) or (not is_buy and not (tp < price < sl)):
            return SimpleNamespace(retcode=TRADE_RETCODE_INVALID_STOPS, comment="Invalid stops", order=0, deal=0,
                                   volume=0.0, price=0.0)
        ticket = _next_ticket()
        _positions[ticket] = SimpleNamespace(
            ticket=ticket, symbol=request["symbol"], type=POSITION_TYPE_BUY if is_buy else POSITION_TYPE_SELL,
            volume=request["volume"], price_open=price, price_current=price, sl=sl, tp=tp, profit=0.0, swap=0.0,
            magic=request.get("magic", 0), comment=request.get("comment", ""), time=int(time.time()),
        )
        _deals.append(SimpleNamespace(ticket=_next_ticket(), position_id=ticket, entry=DEAL_ENTRY_IN, price=price,
                                      volume=request["volume"], profit=0.0, commission=0.0, swap=0.0, fee=0.0,
                                      reason=DEAL_REASON_EXPERT, time=int(time.time())))
        return SimpleNamespace(retcode=TRADE_RETCODE_DONE, comment="Done", order=ticket, deal=ticket,
                               volume=request["volume"], price=price)


def history_deals_get(date_from: Any, date_to: Any, position: Optional[int] = None) -> List[SimpleNamespace]:
    with _lock:
        _step()
        return [d for d in _deals if position is None or d.position_id == position]


# Test hook: move the price instantly (used by bridge tests)
def _set_price(value: float) -> None:
    global _price, _last_step
    with _lock:
        _price = value
        _last_step = time.time()
        _process_stops()
