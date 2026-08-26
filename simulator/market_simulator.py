"""
High-Frequency Market Simulator & Liquidity Generator
Simulates synthetic market participants, geometric brownian price walks,
and Poisson-distributed order bursts against the Matching Engine API.
"""

import urllib.request
import json
import time
import random
import sys

API_URL = "http://localhost:8080"
SYMBOL = "NIFTY50"

def send_order(side, order_type, price, qty):
    payload = {
        "symbol": SYMBOL,
        "side": side,
        "type": order_type,
        "price": int(round(price * 100)),
        "qty": int(qty)
    }
    req = urllib.request.Request(
        f"{API_URL}/api/order",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=1.0) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return {"error": str(e)}

def run_simulation(duration_seconds=30, orders_per_second=50):
    print(f"==========================================================")
    print(f" Starting HFT Synthetic Market Simulation against {API_URL}")
    print(f" Symbol: {SYMBOL} | Target Rate: ~{orders_per_second} orders/sec")
    print(f" Duration: {duration_seconds}s")
    print(f"==========================================================")

    mid_price = 195.00
    start_time = time.time()
    total_sent = 0

    while time.time() - start_time < duration_seconds:
        # Geometric brownian motion step for reference price
        drift = random.gauss(0, 0.08)
        mid_price = max(10.0, mid_price + drift)

        batch_size = random.randint(5, 15)
        for _ in range(batch_size):
            side = "BUY" if random.random() > 0.5 else "SELL"
            
            # 85% Limit orders providing liquidity, 15% Aggressive Market/Crossing orders
            if random.random() < 0.85:
                order_type = "LIMIT"
                spread_offset = (random.randint(1, 12) * 0.05)
                price = (mid_price - spread_offset) if side == "BUY" else (mid_price + spread_offset)
            else:
                order_type = "MARKET"
                price = 0.0

            qty = random.choice([25, 50, 75, 100, 200, 500])
            send_order(side, order_type, price, qty)
            total_sent += 1

        time.sleep(1.0 / (orders_per_second / batch_size))
        elapsed = time.time() - start_time
        rate = total_sent / elapsed if elapsed > 0 else 0
        sys.stdout.write(f"\r[SIM] Sent {total_sent} orders | Current Mid: ${mid_price:.2f} | Avg Rate: {rate:.1f} ops/s")
        sys.stdout.flush()

    print(f"\n\nSimulation completed! Total orders transmitted: {total_sent}")

if __name__ == "__main__":
    run_simulation(duration_seconds=10, orders_per_second=60)
