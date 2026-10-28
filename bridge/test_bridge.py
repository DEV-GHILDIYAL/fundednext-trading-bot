"""Bridge tests against the mock MT5 module.  Run: BRIDGE_MOCK=1 BRIDGE_TOKEN=t python -m pytest -q"""

import os

os.environ.setdefault("BRIDGE_MOCK", "1")
os.environ.setdefault("BRIDGE_TOKEN", "t")

from fastapi.testclient import TestClient  # noqa: E402

import app as bridge  # noqa: E402
import mock_mt5  # noqa: E402

client = TestClient(bridge.app)
AUTH = {"Authorization": f"Bearer {os.environ['BRIDGE_TOKEN']}"}


def test_health_is_public():
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["ok"] is True


def test_auth_required():
    assert client.get("/tick/XAUUSD").status_code == 401
    assert client.get("/tick/XAUUSD", headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_symbol_whitelist():
    assert client.get("/tick/EURUSD", headers=AUTH).status_code == 400


def test_tick_symbol_candles():
    t = client.get("/tick/XAUUSD", headers=AUTH).json()
    assert t["ask"] > t["bid"] > 0
    s = client.get("/symbol/XAUUSD", headers=AUTH).json()
    assert s["volumeStep"] == 0.01 and s["contractSize"] == 100
    c = client.get("/candles/XAUUSD?timeframe=H1&count=30", headers=AUTH).json()["candles"]
    assert len(c) == 30 and c[-1]["closed"] is False and c[-2]["closed"] is True


def test_order_lifecycle_sl_hit():
    mock_mt5._set_price(4000.0)
    r = client.post("/order", headers=AUTH, json={"symbol": "XAUUSD", "side": "BUY", "volume": 0.05,
                                                   "sl": 3990.0, "tp": 4020.0})
    assert r.status_code == 200, r.text
    ticket = r.json()["ticket"]
    pos = client.get("/positions?magic=260101", headers=AUTH).json()["positions"]
    assert any(p["ticket"] == ticket for p in pos)

    mock_mt5._set_price(3980.0)  # through the stop
    pos = client.get("/positions", headers=AUTH).json()["positions"]
    assert not any(p["ticket"] == ticket for p in pos)
    h = client.get(f"/history/position/{ticket}", headers=AUTH).json()
    assert h["closed"] is True and h["exitReason"] == "STOP_LOSS"
    assert h["profit"] == -51.5  # filled at ask 4000.30 → (3990 - 4000.30) * 0.05 lot * 100 oz


def test_invalid_stops_rejected():
    mock_mt5._set_price(4000.0)
    r = client.post("/order", headers=AUTH, json={"symbol": "XAUUSD", "side": "BUY", "volume": 0.01,
                                                   "sl": 4010.0, "tp": 4020.0})
    assert r.status_code == 422


def test_manual_close():
    mock_mt5._set_price(4000.0)
    ticket = client.post("/order", headers=AUTH, json={"symbol": "XAUUSD", "side": "SELL", "volume": 0.02,
                                                        "sl": 4020.0, "tp": 3980.0}).json()["ticket"]
    r = client.post("/close", headers=AUTH, json={"ticket": ticket})
    assert r.status_code == 200
    h = client.get(f"/history/position/{ticket}", headers=AUTH).json()
    assert h["closed"] is True and h["exitReason"] == "MANUAL_OR_BOT"


def test_candles_paging_with_start():
    newest = client.get("/candles/XAUUSD?timeframe=H1&count=5", headers=AUTH).json()["candles"]
    older = client.get("/candles/XAUUSD?timeframe=H1&count=5&start=5", headers=AUTH).json()["candles"]
    assert len(older) == 5
    assert older[-1]["time"] < newest[0]["time"]
