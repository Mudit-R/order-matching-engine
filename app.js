// NexusEngine Terminal Logic & Client-Side In-Memory Matching Core
let currentSymbol = 'NIFTY50';
let currentSide = 'BUY';
let isAutoMMRunning = false;
let autoMMInterval = null;
let useLocalServer = true;

// Client-Side In-Memory Order Book (Guarantees 100% interactive Vercel cloud deployment)
class ClientOrderBook {
    constructor(symbol) {
        this.symbol = symbol;
        this.bids = new Map(); // price -> { totalQty, orders: [] }
        this.asks = new Map();
        this.orderIndex = new Map();
        this.processedOrders = 0;
        this.executedTrades = 0;
        this.recentTrades = [];
        this.orderIdGen = 1000;
        this.seedInitialBook();
    }

    seedInitialBook() {
        const mid = this.symbol === 'NIFTY50' ? 19500 : this.symbol === 'BANKNIFTY' ? 44200 : 25000;
        for (let i = 1; i <= 8; i++) {
            this.addOrder('BUY', 'LIMIT', mid - (i * 20), 50 * i);
            this.addOrder('SELL', 'LIMIT', mid + (i * 20), 40 * i);
        }
    }

    addOrder(side, type, price, qty) {
        this.processedOrders++;
        const id = ++this.orderIdGen;
        let remaining = qty;

        if (side === 'BUY') {
            const sortedAsks = Array.from(this.asks.keys()).sort((a, b) => a - b);
            for (const askPrice of sortedAsks) {
                if (type === 'LIMIT' && askPrice > price) break;
                const level = this.asks.get(askPrice);
                while (level.orders.length > 0 && remaining > 0) {
                    const maker = level.orders[0];
                    const matchQty = Math.min(remaining, maker.qty);
                    remaining -= matchQty;
                    maker.qty -= matchQty;
                    level.totalQty -= matchQty;

                    this.executedTrades++;
                    this.recentTrades.unshift({
                        maker: maker.id,
                        taker: id,
                        price: askPrice,
                        qty: matchQty,
                        side: 'BUY',
                        ts: Date.now() * 1000000
                    });
                    if (this.recentTrades.length > 50) this.recentTrades.pop();

                    if (maker.qty <= 0) {
                        level.orders.shift();
                        this.orderIndex.delete(maker.id);
                    }
                }
                if (level.totalQty <= 0) this.asks.delete(askPrice);
                if (remaining <= 0) break;
            }
        } else {
            const sortedBids = Array.from(this.bids.keys()).sort((a, b) => b - a);
            for (const bidPrice of sortedBids) {
                if (type === 'LIMIT' && bidPrice < price) break;
                const level = this.bids.get(bidPrice);
                while (level.orders.length > 0 && remaining > 0) {
                    const maker = level.orders[0];
                    const matchQty = Math.min(remaining, maker.qty);
                    remaining -= matchQty;
                    maker.qty -= matchQty;
                    level.totalQty -= matchQty;

                    this.executedTrades++;
                    this.recentTrades.unshift({
                        maker: maker.id,
                        taker: id,
                        price: bidPrice,
                        qty: matchQty,
                        side: 'SELL',
                        ts: Date.now() * 1000000
                    });
                    if (this.recentTrades.length > 50) this.recentTrades.pop();

                    if (maker.qty <= 0) {
                        level.orders.shift();
                        this.orderIndex.delete(maker.id);
                    }
                }
                if (level.totalQty <= 0) this.bids.delete(bidPrice);
                if (remaining <= 0) break;
            }
        }

        if (remaining > 0 && type === 'LIMIT') {
            const order = { id, side, price, qty: remaining };
            this.orderIndex.set(id, order);
            const targetMap = side === 'BUY' ? this.bids : this.asks;
            if (!targetMap.has(price)) {
                targetMap.set(price, { totalQty: 0, orders: [] });
            }
            const lvl = targetMap.get(price);
            lvl.orders.push(order);
            lvl.totalQty += remaining;
        }

        return { success: true, order_id: id };
    }

    getSnapshot(maxDepth = 12) {
        const sortedBids = Array.from(this.bids.keys()).sort((a, b) => b - a).slice(0, maxDepth);
        const sortedAsks = Array.from(this.asks.keys()).sort((a, b) => a - b).slice(0, maxDepth);

        const bestBid = sortedBids.length > 0 ? sortedBids[0] : 0;
        const bestAsk = sortedAsks.length > 0 ? sortedAsks[0] : 0;
        const spread = (bestBid && bestAsk && bestAsk >= bestBid) ? (bestAsk - bestBid) : 0;

        return {
            symbol: this.symbol,
            best_bid: bestBid,
            best_ask: bestAsk,
            spread: spread,
            bids: sortedBids.map(p => ({ price: p, qty: this.bids.get(p).totalQty, orders: this.bids.get(p).orders.length })),
            asks: sortedAsks.map(p => ({ price: p, qty: this.asks.get(p).totalQty, orders: this.asks.get(p).orders.length }))
        };
    }
}

const clientBooks = {
    'NIFTY50': new ClientOrderBook('NIFTY50'),
    'BANKNIFTY': new ClientOrderBook('BANKNIFTY'),
    'RELIANCE': new ClientOrderBook('RELIANCE')
};

// DOM Elements
const symbolBtns = document.querySelectorAll('.symbol-btn');
const btnBuy = document.getElementById('btn-buy');
const btnSell = document.getElementById('btn-sell');
const orderForm = document.getElementById('order-form');
const orderTypeSelect = document.getElementById('order-type');
const priceGroup = document.getElementById('price-group');
const orderPriceInput = document.getElementById('order-price');
const orderQtyInput = document.getElementById('order-qty');
const submitBtn = document.getElementById('submit-order-btn');

const asksLadder = document.getElementById('asks-ladder');
const bidsLadder = document.getElementById('bids-ladder');
const spreadVal = document.getElementById('spread-val');
const midVal = document.getElementById('mid-val');
const spreadBadgeVal = document.getElementById('spread-badge-val');
const bestBidVal = document.getElementById('best-bid-val');
const bestAskVal = document.getElementById('best-ask-val');

const statOrders = document.getElementById('stat-orders');
const statTrades = document.getElementById('stat-trades');
const tradeList = document.getElementById('trade-list');
const engineModeStatus = document.getElementById('engine-mode-status');

const depthCanvas = document.getElementById('depth-canvas');
const ctx = depthCanvas.getContext('2d');

// Modals
const archModal = document.getElementById('arch-modal');
const benchModal = document.getElementById('bench-modal');
document.getElementById('open-arch-btn').addEventListener('click', () => archModal.classList.add('show'));
document.getElementById('close-arch-btn').addEventListener('click', () => archModal.classList.remove('show'));
document.getElementById('open-bench-btn').addEventListener('click', () => benchModal.classList.add('show'));
document.getElementById('close-bench-btn').addEventListener('click', () => benchModal.classList.remove('show'));

// Canvas resize
function resizeCanvas() {
    depthCanvas.width = depthCanvas.parentElement.clientWidth;
    depthCanvas.height = depthCanvas.parentElement.clientHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Side Toggle
btnBuy.addEventListener('click', () => {
    currentSide = 'BUY';
    btnBuy.classList.add('active');
    btnSell.classList.remove('active');
    submitBtn.className = 'submit-order-btn buy-btn';
    submitBtn.querySelector('span:first-child').textContent = 'TRANSMIT BUY ORDER';
});

btnSell.addEventListener('click', () => {
    currentSide = 'SELL';
    btnSell.classList.add('active');
    btnBuy.classList.remove('active');
    submitBtn.className = 'submit-order-btn sell-btn';
    submitBtn.querySelector('span:first-child').textContent = 'TRANSMIT SELL ORDER';
});

// Order Type Selection
orderTypeSelect.addEventListener('change', (e) => {
    if (e.target.value === 'MARKET') {
        priceGroup.style.opacity = '0.4';
        orderPriceInput.disabled = true;
    } else {
        priceGroup.style.opacity = '1';
        orderPriceInput.disabled = false;
    }
});

// Stepper
document.getElementById('price-up').addEventListener('click', () => {
    orderPriceInput.value = (parseFloat(orderPriceInput.value) + 0.05).toFixed(2);
});
document.getElementById('price-down').addEventListener('click', () => {
    orderPriceInput.value = Math.max(0.01, parseFloat(orderPriceInput.value) - 0.05).toFixed(2);
});

// Symbol Selection
symbolBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        symbolBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentSymbol = btn.getAttribute('data-symbol');
        orderPriceInput.value = currentSymbol === 'NIFTY50' ? '195.00' : currentSymbol === 'BANKNIFTY' ? '442.00' : '250.00';
        fetchSnapshot();
    });
});

// Submit Order
orderForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = orderTypeSelect.value;
    const priceCents = Math.round(parseFloat(orderPriceInput.value) * 100);
    const qty = parseInt(orderQtyInput.value, 10);

    const payload = {
        symbol: currentSymbol,
        side: currentSide,
        type: type,
        price: type === 'MARKET' ? 0 : priceCents,
        qty: qty
    };

    if (useLocalServer) {
        try {
            await fetch('/api/order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } catch (err) {
            useLocalServer = false;
            clientBooks[currentSymbol].addOrder(payload.side, payload.type, payload.price, payload.qty);
        }
    } else {
        clientBooks[currentSymbol].addOrder(payload.side, payload.type, payload.price, payload.qty);
    }
    fetchSnapshot();
    fetchTrades();
    fetchStats();
});

// HFT Burst Simulation
document.getElementById('sim-burst-100').addEventListener('click', () => runHFTBurst(100));
document.getElementById('sim-burst-1000').addEventListener('click', () => runHFTBurst(1000));

async function runHFTBurst(count) {
    const mid = parseFloat(orderPriceInput.value);
    for (let i = 0; i < count; i++) {
        const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
        const offset = (Math.floor(Math.random() * 20) - 10) * 0.05;
        const price = Math.round((mid + offset) * 100);
        const qty = Math.floor(Math.random() * 150) + 10;
        const type = Math.random() > 0.85 ? 'MARKET' : 'LIMIT';

        if (useLocalServer) {
            try {
                fetch('/api/order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ symbol: currentSymbol, side, type, price: type === 'MARKET' ? 0 : price, qty })
                });
            } catch (err) {
                useLocalServer = false;
                clientBooks[currentSymbol].addOrder(side, type, price, qty);
            }
        } else {
            clientBooks[currentSymbol].addOrder(side, type, price, qty);
        }
    }
    fetchSnapshot();
    fetchTrades();
    fetchStats();
}

// Auto Market Maker Toggle
const toggleBtn = document.getElementById('sim-toggle-stream');
toggleBtn.addEventListener('click', () => {
    isAutoMMRunning = !isAutoMMRunning;
    if (isAutoMMRunning) {
        toggleBtn.textContent = '⏸ Stop Auto MM';
        toggleBtn.style.background = 'rgba(255, 51, 102, 0.2)';
        toggleBtn.style.borderColor = 'var(--ask-red)';
        toggleBtn.style.color = 'var(--ask-red)';
        autoMMInterval = setInterval(() => runHFTBurst(15), 250);
    } else {
        toggleBtn.textContent = '▶ Auto Market Maker';
        toggleBtn.style.background = 'transparent';
        toggleBtn.style.borderColor = 'var(--bid-green)';
        toggleBtn.style.color = 'var(--bid-green)';
        clearInterval(autoMMInterval);
    }
});

// Polling & Render Engine
async function fetchSnapshot() {
    if (useLocalServer) {
        try {
            const res = await fetch(`/api/snapshot?symbol=${currentSymbol}`);
            if (res.ok) {
                const data = await res.json();
                renderOrderBook(data);
                drawDepthChart(data);
                return;
            }
        } catch (e) {
            useLocalServer = false;
        }
    }
    const data = clientBooks[currentSymbol].getSnapshot();
    renderOrderBook(data);
    drawDepthChart(data);
}

async function fetchTrades() {
    if (useLocalServer) {
        try {
            const res = await fetch('/api/trades');
            if (res.ok) {
                const trades = await res.json();
                renderTrades(trades);
                return;
            }
        } catch (e) {
            useLocalServer = false;
        }
    }
    renderTrades(clientBooks[currentSymbol].recentTrades);
}

async function fetchStats() {
    if (useLocalServer) {
        try {
            const res = await fetch('/api/stats');
            if (res.ok) {
                const stats = await res.json();
                statOrders.textContent = Number(stats.processed_orders).toLocaleString();
                statTrades.textContent = Number(stats.executed_trades).toLocaleString();
                return;
            }
        } catch (e) {
            useLocalServer = false;
        }
    }
    let totalOrders = 0;
    let totalTrades = 0;
    Object.values(clientBooks).forEach(b => {
        totalOrders += b.processedOrders;
        totalTrades += b.executedTrades;
    });
    statOrders.textContent = totalOrders.toLocaleString();
    statTrades.textContent = totalTrades.toLocaleString();
}

function renderOrderBook(data) {
    const bids = data.bids || [];
    const asks = data.asks || [];

    let maxCumulative = 0;
    let bidCum = 0;
    bids.forEach(b => { bidCum += b.qty; });
    let askCum = 0;
    asks.forEach(a => { askCum += a.qty; });
    maxCumulative = Math.max(bidCum, askCum, 1);

    const bestBid = data.best_bid ? (data.best_bid / 100).toFixed(2) : '--';
    const bestAsk = data.best_ask ? (data.best_ask / 100).toFixed(2) : '--';
    const spread = data.spread ? (data.spread / 100).toFixed(2) : '0.00';
    const mid = (data.best_bid && data.best_ask) ? ((data.best_bid + data.best_ask) / 200).toFixed(2) : '--';

    bestBidVal.textContent = `$${bestBid}`;
    bestAskVal.textContent = `$${bestAsk}`;
    spreadVal.textContent = `$${spread}`;
    spreadBadgeVal.textContent = `SPREAD: $${spread}`;
    midVal.textContent = `$${mid}`;

    let askRows = '';
    let runningAskCum = 0;
    const reversedAsks = [...asks].slice(0, 10).reverse();
    reversedAsks.forEach(a => {
        runningAskCum += a.qty;
        const pct = Math.min(100, (runningAskCum / maxCumulative) * 100);
        askRows += `
            <div class="ob-row" onclick="fillPrice(${a.price / 100})">
                <div class="ob-bar" style="width: ${pct}%"></div>
                <span class="price-cell">$${(a.price / 100).toFixed(2)}</span>
                <span class="text-right">${a.qty.toLocaleString()}</span>
                <span class="text-right text-muted">${a.orders}</span>
                <span class="text-right text-muted">${runningAskCum.toLocaleString()}</span>
            </div>
        `;
    });
    asksLadder.innerHTML = askRows;

    let bidRows = '';
    let runningBidCum = 0;
    bids.slice(0, 10).forEach(b => {
        runningBidCum += b.qty;
        const pct = Math.min(100, (runningBidCum / maxCumulative) * 100);
        bidRows += `
            <div class="ob-row" onclick="fillPrice(${b.price / 100})">
                <div class="ob-bar" style="width: ${pct}%"></div>
                <span class="price-cell">$${(b.price / 100).toFixed(2)}</span>
                <span class="text-right">${b.qty.toLocaleString()}</span>
                <span class="text-right text-muted">${b.orders}</span>
                <span class="text-right text-muted">${runningBidCum.toLocaleString()}</span>
            </div>
        `;
    });
    bidsLadder.innerHTML = bidRows;
}

function fillPrice(price) {
    orderPriceInput.value = price.toFixed(2);
}

function renderTrades(trades) {
    if (!trades || trades.length === 0) return;
    let html = '';
    trades.slice(0, 18).forEach(t => {
        const timeStr = new Date(Number(t.ts / 1000000n)).toLocaleTimeString();
        const sideClass = t.side === 'BUY' ? 'buy-taker' : 'sell-taker';
        html += `
            <div class="trade-row ${sideClass}">
                <span class="text-muted">${timeStr}</span>
                <span class="price-cell">$${(t.price / 100).toFixed(2)}</span>
                <span class="text-right">${t.qty}</span>
                <span class="text-right text-muted">#${t.maker} / #${t.taker}</span>
            </div>
        `;
    });
    tradeList.innerHTML = html;
}

function drawDepthChart(data) {
    const width = depthCanvas.width;
    const height = depthCanvas.height;
    ctx.clearRect(0, 0, width, height);

    const bids = data.bids || [];
    const asks = data.asks || [];
    if (bids.length === 0 && asks.length === 0) return;

    let bidCum = 0;
    const bidPoints = bids.map(b => {
        bidCum += b.qty;
        return { price: b.price / 100, cum: bidCum };
    });

    let askCum = 0;
    const askPoints = asks.map(a => {
        askCum += a.qty;
        return { price: a.price / 100, cum: askCum };
    });

    const maxCum = Math.max(bidCum, askCum, 1);
    const midX = width / 2;

    ctx.beginPath();
    ctx.moveTo(midX, height);
    for (let i = 0; i < bidPoints.length; i++) {
        const x = midX - ((i + 1) / Math.max(bidPoints.length, 1)) * (width / 2);
        const y = height - (bidPoints[i].cum / maxCum) * (height - 20);
        ctx.lineTo(x, y);
    }
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 245, 155, 0.2)';
    ctx.fill();
    ctx.strokeStyle = '#00f59b';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(midX, height);
    for (let i = 0; i < askPoints.length; i++) {
        const x = midX + ((i + 1) / Math.max(askPoints.length, 1)) * (width / 2);
        const y = height - (askPoints[i].cum / maxCum) * (height - 20);
        ctx.lineTo(x, y);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 51, 102, 0.2)';
    ctx.fill();
    ctx.strokeStyle = '#ff3366';
    ctx.lineWidth = 2;
    ctx.stroke();
}

// In-Browser Benchmark Runner
document.getElementById('run-bench-action-btn').addEventListener('click', () => {
    const btn = document.getElementById('run-bench-action-btn');
    btn.textContent = 'RUNNING 50,000 MATCHES...';
    btn.disabled = true;

    setTimeout(() => {
        const benchBook = new ClientOrderBook('BENCH');
        const N = 50000;
        const latenciesUs = [];
        const tStart = performance.now();

        for (let i = 0; i < N; i++) {
            const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
            const price = 19500 + Math.floor(Math.random() * 400) - 200;
            const qty = Math.floor(Math.random() * 100) + 10;
            const type = Math.random() > 0.85 ? 'MARKET' : 'LIMIT';

            const t0 = performance.now();
            benchBook.addOrder(side, type, price, qty);
            const t1 = performance.now();
            latenciesUs.push((t1 - t0) * 1000);
        }

        const tEnd = performance.now();
        const totalSec = (tEnd - tStart) / 1000;
        const tps = Math.round(N / totalSec);

        latenciesUs.sort((a, b) => a - b);
        const avg = (latenciesUs.reduce((a, b) => a + b, 0) / N).toFixed(2);
        const p50 = latenciesUs[Math.floor(N * 0.5)].toFixed(2);
        const p99 = latenciesUs[Math.floor(N * 0.99)].toFixed(2);

        document.getElementById('b-tps').textContent = `${tps.toLocaleString()} ops/s`;
        document.getElementById('b-avg').textContent = `${avg} µs`;
        document.getElementById('b-p50').textContent = `${p50} µs`;
        document.getElementById('b-p99').textContent = `${p99} µs`;

        document.getElementById('bench-results').style.display = 'block';
        btn.textContent = '▶ RUN AGAIN';
        btn.disabled = false;
    }, 50);
});

// Initial tick
fetchSnapshot();
fetchTrades();
fetchStats();
setInterval(() => {
    fetchSnapshot();
    fetchTrades();
    fetchStats();
}, 200);
