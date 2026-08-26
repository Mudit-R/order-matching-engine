// NexusCore Institutional Matching Engine Client Controller v2.4
let currentSymbol = 'NIFTY50';
let currentSide = 'BUY';
let currentChartTab = 'depth'; // 'depth' or 'candle'
let currentTickSize = 0.05;
let isAutoMMRunning = false;
let autoMMInterval = null;
let isAudioEnabled = true;

// Web Audio API Synthesizer (Professional subtle click and fill chime)
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function playTradeSound() {
    if (!isAudioEnabled) return;
    try {
        if (!audioCtx) audioCtx = new AudioCtx();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1760, audioCtx.currentTime + 0.06);
        gain.gain.setValueAtTime(0.04, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.06);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.06);
    } catch (e) {}
}

function playClickSound() {
    if (!isAudioEnabled) return;
    try {
        if (!audioCtx) audioCtx = new AudioCtx();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(260, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.02, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.03);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.03);
    } catch (e) {}
}

// In-Memory Double-Auction Order Book Engine (Full Client-Side Runtime for Vercel Edge)
class ClientOrderBook {
    constructor(symbol) {
        this.symbol = symbol;
        this.bids = new Map(); // price -> { totalQty, orders: [] }
        this.asks = new Map();
        this.orderIndex = new Map();
        this.userWorkingOrders = [];
        this.processedOrders = 0;
        this.executedTrades = 0;
        this.recentTrades = [];
        this.fixMessages = [];
        this.candles = [];
        this.orderIdGen = 1000;
        this.clientIdGen = 1;
        this.seedInitialBook();
        this.seedCandles();
    }

    seedInitialBook() {
        const mid = this.symbol === 'NIFTY50' ? 19500 : this.symbol === 'BANKNIFTY' ? 44200 : 25000;
        for (let i = 1; i <= 10; i++) {
            this.addOrder('BUY', 'LIMIT', mid - (i * 20), 50 * i);
            this.addOrder('SELL', 'LIMIT', mid + (i * 20), 40 * i);
        }
    }

    seedCandles() {
        let base = this.symbol === 'NIFTY50' ? 195.00 : this.symbol === 'BANKNIFTY' ? 442.00 : 250.00;
        const now = Date.now() - 30 * 60000;
        for (let i = 0; i < 35; i++) {
            const open = base;
            const high = open + Math.random() * 0.35;
            const low = open - Math.random() * 0.35;
            const close = (Math.random() > 0.5) ? high - Math.random() * 0.15 : low + Math.random() * 0.15;
            const volume = Math.floor(Math.random() * 5000) + 1000;
            this.candles.push({ time: now + i * 60000, open, high, low, close, volume });
            base = close;
        }
    }

    updateCandles(tradePrice, tradeQty) {
        const p = tradePrice / 100.0;
        if (this.candles.length === 0) return;
        const last = this.candles[this.candles.length - 1];
        const now = Date.now();
        if (now - last.time > 60000) {
            this.candles.push({ time: now, open: p, high: p, low: p, close: p, volume: tradeQty });
            if (this.candles.length > 50) this.candles.shift();
        } else {
            last.high = Math.max(last.high, p);
            last.low = Math.min(last.low, p);
            last.close = p;
            last.volume += tradeQty;
        }
    }

    addOrder(side, type, price, qty, displayQty = 0, stp = 'NONE', isUserOrder = false) {
        this.processedOrders++;
        const id = ++this.orderIdGen;
        const clientId = isUserOrder ? 999 : this.clientIdGen++;
        let remaining = qty;
        let visibleQty = (displayQty > 0 && displayQty < qty) ? displayQty : qty;
        let hiddenQty = (displayQty > 0 && displayQty < qty) ? (qty - displayQty) : 0;

        // FIX Log Entry (35=D NewOrderSingle)
        this.logFIXMessage(`8=FIX.4.2|35=D|11=ORD_${id}|55=${this.symbol}|54=${side === 'BUY' ? '1' : '2'}|38=${qty}|44=${(price/100).toFixed(2)}|40=${type}|10=000`);

        // Post-Only check
        if (type === 'POST_ONLY') {
            const bestAsk = this.getBestAsk();
            const bestBid = this.getBestBid();
            if (side === 'BUY' && bestAsk > 0 && price >= bestAsk) return { success: false, reason: 'POST_ONLY_WOULD_CROSS' };
            if (side === 'SELL' && bestBid > 0 && price <= bestBid) return { success: false, reason: 'POST_ONLY_WOULD_CROSS' };
        }

        if (side === 'BUY') {
            const sortedAsks = Array.from(this.asks.keys()).sort((a, b) => a - b);
            for (const askPrice of sortedAsks) {
                if (type === 'LIMIT' && askPrice > price) break;
                if (type === 'POST_ONLY') break;

                const level = this.asks.get(askPrice);
                while (level.orders.length > 0 && remaining > 0) {
                    const maker = level.orders[0];

                    // STP Check
                    if (maker.clientId === clientId && stp !== 'NONE') {
                        if (stp === 'CANCEL_TAKER') return { success: false, reason: 'STP_CANCEL_TAKER' };
                        if (stp === 'CANCEL_MAKER') {
                            level.orders.shift();
                            this.orderIndex.delete(maker.id);
                            continue;
                        }
                    }

                    const matchQty = Math.min(remaining, maker.remainingQty);
                    remaining -= matchQty;
                    maker.remainingQty -= matchQty;
                    level.totalQty -= matchQty;

                    this.executedTrades++;
                    this.updateCandles(askPrice, matchQty);
                    playTradeSound();

                    // FIX Execution Report (35=8)
                    this.logFIXMessage(`8=FIX.4.2|35=8|11=ORD_${id}|17=EXEC_${this.executedTrades}|150=2|39=2|55=${this.symbol}|54=1|38=${matchQty}|44=${(askPrice/100).toFixed(2)}|32=${matchQty}|31=${(askPrice/100).toFixed(2)}|10=000`);

                    this.recentTrades.unshift({
                        maker: maker.id,
                        taker: id,
                        price: askPrice,
                        qty: matchQty,
                        side: 'BUY',
                        ts: Date.now() * 1000000
                    });
                    if (this.recentTrades.length > 50) this.recentTrades.pop();

                    if (maker.remainingQty <= 0) {
                        if (maker.hiddenQty > 0) {
                            const replenish = Math.min(maker.displayQty, maker.hiddenQty);
                            maker.hiddenQty -= replenish;
                            maker.remainingQty = replenish;
                            level.totalQty += replenish;
                            level.orders.shift();
                            level.orders.push(maker);
                        } else {
                            level.orders.shift();
                            this.orderIndex.delete(maker.id);
                            this.removeUserWorkingOrder(maker.id);
                        }
                    }
                }
                if (level.totalQty <= 0) this.asks.delete(askPrice);
                if (remaining <= 0) break;
            }
        } else {
            const sortedBids = Array.from(this.bids.keys()).sort((a, b) => b - a);
            for (const bidPrice of sortedBids) {
                if (type === 'LIMIT' && bidPrice < price) break;
                if (type === 'POST_ONLY') break;

                const level = this.bids.get(bidPrice);
                while (level.orders.length > 0 && remaining > 0) {
                    const maker = level.orders[0];

                    if (maker.clientId === clientId && stp !== 'NONE') {
                        if (stp === 'CANCEL_TAKER') return { success: false, reason: 'STP_CANCEL_TAKER' };
                        if (stp === 'CANCEL_MAKER') {
                            level.orders.shift();
                            this.orderIndex.delete(maker.id);
                            continue;
                        }
                    }

                    const matchQty = Math.min(remaining, maker.remainingQty);
                    remaining -= matchQty;
                    maker.remainingQty -= matchQty;
                    level.totalQty -= matchQty;

                    this.executedTrades++;
                    this.updateCandles(bidPrice, matchQty);
                    playTradeSound();

                    this.logFIXMessage(`8=FIX.4.2|35=8|11=ORD_${id}|17=EXEC_${this.executedTrades}|150=2|39=2|55=${this.symbol}|54=2|38=${matchQty}|44=${(bidPrice/100).toFixed(2)}|32=${matchQty}|31=${(bidPrice/100).toFixed(2)}|10=000`);

                    this.recentTrades.unshift({
                        maker: maker.id,
                        taker: id,
                        price: bidPrice,
                        qty: matchQty,
                        side: 'SELL',
                        ts: Date.now() * 1000000
                    });
                    if (this.recentTrades.length > 50) this.recentTrades.pop();

                    if (maker.remainingQty <= 0) {
                        if (maker.hiddenQty > 0) {
                            const replenish = Math.min(maker.displayQty, maker.hiddenQty);
                            maker.hiddenQty -= replenish;
                            maker.remainingQty = replenish;
                            level.totalQty += replenish;
                            level.orders.shift();
                            level.orders.push(maker);
                        } else {
                            level.orders.shift();
                            this.orderIndex.delete(maker.id);
                            this.removeUserWorkingOrder(maker.id);
                        }
                    }
                }
                if (level.totalQty <= 0) this.bids.delete(bidPrice);
                if (remaining <= 0) break;
            }
        }

        if (remaining > 0 && (type === 'LIMIT' || type === 'POST_ONLY')) {
            const order = { id, clientId, side, price, remainingQty: visibleQty, displayQty: visibleQty, hiddenQty, type };
            this.orderIndex.set(id, order);
            const targetMap = side === 'BUY' ? this.bids : this.asks;
            if (!targetMap.has(price)) {
                targetMap.set(price, { totalQty: 0, orders: [] });
            }
            const lvl = targetMap.get(price);
            lvl.orders.push(order);
            lvl.totalQty += visibleQty;

            if (isUserOrder) {
                this.userWorkingOrders.push({ id, side, price, qty: remaining, type });
            }
        }

        return { success: true, order_id: id };
    }

    cancelOrder(id) {
        const order = this.orderIndex.get(id);
        if (!order) return false;
        this.orderIndex.delete(id);
        this.removeUserWorkingOrder(id);

        const targetMap = order.side === 'BUY' ? this.bids : this.asks;
        const level = targetMap.get(order.price);
        if (level) {
            level.orders = level.orders.filter(o => o.id !== id);
            level.totalQty -= order.remainingQty;
            if (level.totalQty <= 0) targetMap.delete(order.price);
        }

        this.logFIXMessage(`8=FIX.4.2|35=F|11=CANC_${id}|41=ORD_${id}|55=${this.symbol}|54=${order.side === 'BUY' ? '1' : '2'}|10=000`);
        return true;
    }

    removeUserWorkingOrder(id) {
        this.userWorkingOrders = this.userWorkingOrders.filter(o => o.id !== id);
    }

    logFIXMessage(raw) {
        this.fixMessages.unshift({ time: new Date().toLocaleTimeString(), raw });
        if (this.fixMessages.length > 80) this.fixMessages.pop();
    }

    getBestBid() {
        const keys = Array.from(this.bids.keys());
        return keys.length > 0 ? Math.max(...keys) : 0;
    }

    getBestAsk() {
        const keys = Array.from(this.asks.keys());
        return keys.length > 0 ? Math.min(...keys) : 0;
    }

    getSnapshot(maxDepth = 12, tickAggregation = 0.05) {
        const aggTicks = Math.round(tickAggregation * 100);
        const aggBids = new Map();
        for (const [p, lvl] of this.bids.entries()) {
            const bucket = Math.floor(p / aggTicks) * aggTicks;
            aggBids.set(bucket, (aggBids.get(bucket) || 0) + lvl.totalQty);
        }

        const aggAsks = new Map();
        for (const [p, lvl] of this.asks.entries()) {
            const bucket = Math.ceil(p / aggTicks) * aggTicks;
            aggAsks.set(bucket, (aggAsks.get(bucket) || 0) + lvl.totalQty);
        }

        const sortedBids = Array.from(aggBids.keys()).sort((a, b) => b - a).slice(0, maxDepth);
        const sortedAsks = Array.from(aggAsks.keys()).sort((a, b) => a - b).slice(0, maxDepth);

        const bestBid = this.getBestBid();
        const bestAsk = this.getBestAsk();
        const spread = (bestBid && bestAsk && bestAsk >= bestBid) ? (bestAsk - bestBid) : 0;

        return {
            symbol: this.symbol,
            best_bid: bestBid,
            best_ask: bestAsk,
            spread: spread,
            bids: sortedBids.map(p => ({ price: p, qty: aggBids.get(p), orders: 1 })),
            asks: sortedAsks.map(p => ({ price: p, qty: aggAsks.get(p), orders: 1 }))
        };
    }
}

const clientBooks = {
    'NIFTY50': new ClientOrderBook('NIFTY50'),
    'BANKNIFTY': new ClientOrderBook('BANKNIFTY'),
    'RELIANCE': new ClientOrderBook('RELIANCE')
};

// DOM References
const symbolBtns = document.querySelectorAll('.inst-btn');
const btnSideBuy = document.getElementById('btn-side-buy');
const btnSideSell = document.getElementById('btn-side-sell');
const orderForm = document.getElementById('order-form');
const orderTypeSelect = document.getElementById('order-type');
const stpModeSelect = document.getElementById('stp-mode');
const priceFieldWrap = document.getElementById('price-field-wrap');
const orderPriceInput = document.getElementById('order-price');
const orderQtyInput = document.getElementById('order-qty');
const icebergQtyInput = document.getElementById('iceberg-qty');
const executeBtn = document.getElementById('execute-btn');
const selectTickGroup = document.getElementById('select-tick-group');

const asksStream = document.getElementById('asks-stream');
const bidsStream = document.getElementById('bids-stream');
const midPriceDisplay = document.getElementById('mid-price-display');
const spreadAmount = document.getElementById('spread-amount');
const spreadBps = document.getElementById('spread-bps');

const barOrders = document.getElementById('bar-orders');
const barTrades = document.getElementById('bar-trades');
const tradesListBody = document.getElementById('trades-list-body');
const openOrdersListBody = document.getElementById('open-orders-list-body');
const openOrdersCount = document.getElementById('open-orders-count');
const fixWireTerminal = document.getElementById('fix-wire-terminal');

const tabViewDepth = document.getElementById('tab-view-depth');
const tabViewCandle = document.getElementById('tab-view-candle');
const chartLegend = document.getElementById('chart-legend');

const tabTradesFeed = document.getElementById('tab-trades-feed');
const tabOpenOrders = document.getElementById('tab-open-orders');
const tabFixLog = document.getElementById('tab-fix-log');
const viewTradesStream = document.getElementById('view-trades-stream');
const viewOpenOrders = document.getElementById('view-open-orders');
const viewFixWire = document.getElementById('view-fix-wire');

const mainTradingCanvas = document.getElementById('main-trading-canvas');
const ctx = mainTradingCanvas.getContext('2d');

// Modals
const modalArch = document.getElementById('modal-architecture');
const modalBench = document.getElementById('modal-benchmark');
document.getElementById('btn-open-arch').addEventListener('click', () => modalArch.classList.add('active'));
document.getElementById('close-modal-arch').addEventListener('click', () => modalArch.classList.remove('active'));
document.getElementById('btn-open-bench').addEventListener('click', () => modalBench.classList.add('active'));
document.getElementById('close-modal-bench').addEventListener('click', () => modalBench.classList.remove('active'));

// Audio Toggle
const btnToggleAudio = document.getElementById('btn-toggle-audio');
btnToggleAudio.addEventListener('click', () => {
    isAudioEnabled = !isAudioEnabled;
    btnToggleAudio.textContent = isAudioEnabled ? 'Audio: ON' : 'Audio: MUTED';
    btnToggleAudio.style.color = isAudioEnabled ? 'var(--text-primary)' : 'var(--text-muted)';
});

// Tab Switchers
tabViewDepth.addEventListener('click', () => {
    currentChartTab = 'depth';
    tabViewDepth.classList.add('active');
    tabViewCandle.classList.remove('active');
    chartLegend.innerHTML = '<span class="legend-bid">■ Bid Depth</span><span class="legend-ask">■ Ask Depth</span>';
    fetchSnapshot();
});

tabViewCandle.addEventListener('click', () => {
    currentChartTab = 'candle';
    tabViewCandle.classList.add('active');
    tabViewDepth.classList.remove('active');
    chartLegend.innerHTML = '<span class="legend-bid">■ Bull Candle</span><span class="legend-ask">■ Bear Candle</span>';
    fetchSnapshot();
});

tabTradesFeed.addEventListener('click', () => {
    tabTradesFeed.classList.add('active');
    tabOpenOrders.classList.remove('active');
    tabFixLog.classList.remove('active');
    viewTradesStream.classList.add('active');
    viewOpenOrders.classList.remove('active');
    viewFixWire.classList.remove('active');
});

tabOpenOrders.addEventListener('click', () => {
    tabOpenOrders.classList.add('active');
    tabTradesFeed.classList.remove('active');
    tabFixLog.classList.remove('active');
    viewOpenOrders.classList.add('active');
    viewTradesStream.classList.remove('active');
    viewFixWire.classList.remove('active');
    renderOpenOrders();
});

tabFixLog.addEventListener('click', () => {
    tabFixLog.classList.add('active');
    tabTradesFeed.classList.remove('active');
    tabOpenOrders.classList.remove('active');
    viewFixWire.classList.add('active');
    viewTradesStream.classList.remove('active');
    viewOpenOrders.classList.remove('active');
    renderFIXWire();
});

selectTickGroup.addEventListener('change', (e) => {
    currentTickSize = parseFloat(e.target.value);
    fetchSnapshot();
});

function resizeCanvas() {
    mainTradingCanvas.width = mainTradingCanvas.parentElement.clientWidth;
    mainTradingCanvas.height = mainTradingCanvas.parentElement.clientHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Side Toggle
btnSideBuy.addEventListener('click', () => {
    currentSide = 'BUY';
    btnSideBuy.className = 'side-action-btn buy-active';
    btnSideSell.className = 'side-action-btn';
    executeBtn.className = 'execute-order-btn buy-exec';
    executeBtn.querySelector('.exec-primary-text').textContent = 'Place Buy Order';
});

btnSideSell.addEventListener('click', () => {
    currentSide = 'SELL';
    btnSideSell.className = 'side-action-btn sell-active';
    btnSideBuy.className = 'side-action-btn';
    executeBtn.className = 'execute-order-btn sell-exec';
    executeBtn.querySelector('.exec-primary-text').textContent = 'Place Sell Order';
});

// Order Type Selection
orderTypeSelect.addEventListener('change', (e) => {
    if (e.target.value === 'MARKET') {
        priceFieldWrap.style.opacity = '0.35';
        orderPriceInput.disabled = true;
    } else {
        priceFieldWrap.style.opacity = '1';
        orderPriceInput.disabled = false;
    }
});

// Stepper Buttons
document.getElementById('step-price-up').addEventListener('click', () => {
    orderPriceInput.value = (parseFloat(orderPriceInput.value) + currentTickSize).toFixed(2);
});
document.getElementById('step-price-down').addEventListener('click', () => {
    orderPriceInput.value = Math.max(0.01, parseFloat(orderPriceInput.value) - currentTickSize).toFixed(2);
});

// Quantity Quick Percentage Select
document.querySelectorAll('.pct-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const pct = parseFloat(btn.getAttribute('data-pct'));
        orderQtyInput.value = Math.round(500 * pct);
    });
});

// Instrument Selection
symbolBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        symbolBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentSymbol = btn.getAttribute('data-symbol');
        orderPriceInput.value = currentSymbol === 'NIFTY50' ? '195.00' : currentSymbol === 'BANKNIFTY' ? '442.00' : '250.00';
        fetchSnapshot();
        renderOpenOrders();
    });
});

// Submit Order
orderForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    playClickSound();
    const type = orderTypeSelect.value;
    const stp = stpModeSelect.value;
    const priceCents = Math.round(parseFloat(orderPriceInput.value) * 100);
    const qty = parseInt(orderQtyInput.value, 10);
    const displayQty = icebergQtyInput.value ? parseInt(icebergQtyInput.value, 10) : 0;

    const payload = {
        symbol: currentSymbol,
        side: currentSide,
        type: type,
        price: type === 'MARKET' ? 0 : priceCents,
        qty: qty,
        displayQty: displayQty,
        stp: stp
    };

    clientBooks[currentSymbol].addOrder(payload.side, payload.type, payload.price, payload.qty, payload.displayQty, payload.stp, true);
    fetchSnapshot();
    fetchTrades();
    fetchStats();
    renderOpenOrders();
});

// Cancel Order
window.cancelOrder = function(id) {
    playClickSound();
    clientBooks[currentSymbol].cancelOrder(id);
    fetchSnapshot();
    renderOpenOrders();
    renderFIXWire();
};

function renderOpenOrders() {
    const list = clientBooks[currentSymbol].userWorkingOrders;
    openOrdersCount.textContent = list.length;
    if (list.length === 0) {
        openOrdersListBody.innerHTML = '<div class="empty-state-row">No active resting orders in queue</div>';
        return;
    }
    let html = '';
    list.forEach(o => {
        const sideColor = o.side === 'BUY' ? 'color: var(--color-buy)' : 'color: var(--color-sell)';
        html += `
            <div class="order-row-item">
                <span>#${o.id}</span>
                <span style="${sideColor}; font-weight:600">${o.side}</span>
                <span>${o.type}</span>
                <span>$${(o.price / 100).toFixed(2)}</span>
                <span>${o.qty}</span>
                <div class="col-right">
                    <button class="order-cancel-btn" onclick="cancelOrder(${o.id})">Cancel</button>
                </div>
            </div>
        `;
    });
    openOrdersListBody.innerHTML = html;
}

// Algorithmic HFT simulation
document.getElementById('btn-burst-100').addEventListener('click', () => runHFTBurst(100));
document.getElementById('btn-burst-1000').addEventListener('click', () => runHFTBurst(1000));

async function runHFTBurst(count) {
    playClickSound();
    const mid = parseFloat(orderPriceInput.value);
    for (let i = 0; i < count; i++) {
        const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
        const offset = (Math.floor(Math.random() * 16) - 8) * currentTickSize;
        const price = Math.round((mid + offset) * 100);
        const qty = Math.floor(Math.random() * 150) + 10;
        const type = Math.random() > 0.88 ? 'MARKET' : 'LIMIT';

        clientBooks[currentSymbol].addOrder(side, type, price, qty);
    }
    fetchSnapshot();
    fetchTrades();
    fetchStats();
}

// Auto Market Maker
const toggleBtn = document.getElementById('btn-toggle-mm');
toggleBtn.addEventListener('click', () => {
    isAutoMMRunning = !isAutoMMRunning;
    if (isAutoMMRunning) {
        toggleBtn.textContent = 'Stop Auto Market Maker';
        toggleBtn.style.color = 'var(--color-sell)';
        toggleBtn.style.borderColor = 'var(--color-sell)';
        autoMMInterval = setInterval(() => runHFTBurst(15), 200);
    } else {
        toggleBtn.textContent = 'Start Auto Market Maker';
        toggleBtn.style.color = 'var(--color-cyan)';
        toggleBtn.style.borderColor = 'var(--border-strong)';
        clearInterval(autoMMInterval);
    }
});

function fetchSnapshot() {
    const data = clientBooks[currentSymbol].getSnapshot(12, currentTickSize);
    renderOrderBook(data);
    if (currentChartTab === 'depth') {
        drawDepthChart(data);
    } else {
        drawCandlestickChart(clientBooks[currentSymbol].candles);
    }
}

function fetchTrades() {
    renderTrades(clientBooks[currentSymbol].recentTrades);
}

function fetchStats() {
    let totalOrders = 0;
    let totalTrades = 0;
    Object.values(clientBooks).forEach(b => {
        totalOrders += b.processedOrders;
        totalTrades += b.executedTrades;
    });
    barOrders.textContent = totalOrders.toLocaleString();
    barTrades.textContent = totalTrades.toLocaleString();
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
    const mid = (data.best_bid && data.best_ask) ? ((data.best_bid + data.best_ask) / 200).toFixed(2) : '19,500.00';

    midPriceDisplay.textContent = `${mid}`;
    spreadAmount.textContent = `${spread}`;
    const bps = data.best_bid ? ((data.spread / data.best_bid) * 10000).toFixed(2) : '0.00';
    spreadBps.textContent = `${bps} bps`;

    // Asks Ladder
    let askRows = '';
    let runningAskCum = 0;
    const reversedAsks = [...asks].slice(0, 11).reverse();
    reversedAsks.forEach(a => {
        runningAskCum += a.qty;
        const pct = Math.min(100, (runningAskCum / maxCumulative) * 100);
        askRows += `
            <div class="ob-line-row" onclick="fillPrice(${a.price / 100})">
                <div class="ob-depth-bar" style="width: ${pct}%"></div>
                <span class="price-num">${(a.price / 100).toFixed(2)}</span>
                <span class="col-qty">${a.qty.toLocaleString()}</span>
                <span class="col-orders" style="color: var(--text-muted)">1</span>
                <span class="col-total" style="color: var(--text-muted)">${runningAskCum.toLocaleString()}</span>
            </div>
        `;
    });
    asksStream.innerHTML = askRows;

    // Bids Ladder
    let bidRows = '';
    let runningBidCum = 0;
    bids.slice(0, 11).forEach(b => {
        runningBidCum += b.qty;
        const pct = Math.min(100, (runningBidCum / maxCumulative) * 100);
        bidRows += `
            <div class="ob-line-row" onclick="fillPrice(${b.price / 100})">
                <div class="ob-depth-bar" style="width: ${pct}%"></div>
                <span class="price-num">${(b.price / 100).toFixed(2)}</span>
                <span class="col-qty">${b.qty.toLocaleString()}</span>
                <span class="col-orders" style="color: var(--text-muted)">1</span>
                <span class="col-total" style="color: var(--text-muted)">${runningBidCum.toLocaleString()}</span>
            </div>
        `;
    });
    bidsStream.innerHTML = bidRows;
}

function fillPrice(price) {
    orderPriceInput.value = price.toFixed(2);
}

function renderTrades(trades) {
    if (!trades || trades.length === 0) return;
    let html = '';
    trades.slice(0, 16).forEach(t => {
        const timeStr = new Date(Number(t.ts / 1000000n)).toLocaleTimeString();
        const sideClass = t.side === 'BUY' ? 'buy-fill' : 'sell-fill';
        html += `
            <div class="trade-row-item ${sideClass}">
                <span style="color: var(--text-muted)">${timeStr}</span>
                <span class="p-cell">${(t.price / 100).toFixed(2)}</span>
                <span class="col-right">${t.qty}</span>
                <span class="col-right" style="color: var(--text-muted)">#${t.maker} / #${t.taker}</span>
            </div>
        `;
    });
    tradesListBody.innerHTML = html;
}

function renderFIXWire() {
    const list = clientBooks[currentSymbol].fixMessages;
    let html = '';
    list.forEach(m => {
        const parts = m.raw.split('|');
        const formatted = parts.map(p => `<span class="fix-t">${p}</span>`).join('<span class="fix-d">|</span>');
        html += `<div class="fix-line"><span style="color: var(--text-muted)">[${m.time}]</span> ${formatted}</div>`;
    });
    fixWireTerminal.innerHTML = html;
}

function drawDepthChart(data) {
    const width = mainTradingCanvas.width;
    const height = mainTradingCanvas.height;
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

    // Grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let y = 30; y < height; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }

    // Bids Curve
    ctx.beginPath();
    ctx.moveTo(midX, height);
    for (let i = 0; i < bidPoints.length; i++) {
        const x = midX - ((i + 1) / Math.max(bidPoints.length, 1)) * (width / 2);
        const y = height - (bidPoints[i].cum / maxCum) * (height - 24);
        ctx.lineTo(x, y);
    }
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = 'rgba(16, 185, 129, 0.12)';
    ctx.fill();
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Asks Curve
    ctx.beginPath();
    ctx.moveTo(midX, height);
    for (let i = 0; i < askPoints.length; i++) {
        const x = midX + ((i + 1) / Math.max(askPoints.length, 1)) * (width / 2);
        const y = height - (askPoints[i].cum / maxCum) * (height - 24);
        ctx.lineTo(x, y);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = 'rgba(239, 68, 68, 0.12)';
    ctx.fill();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1.5;
    ctx.stroke();
}

function drawCandlestickChart(candles) {
    const width = mainTradingCanvas.width;
    const height = mainTradingCanvas.height;
    ctx.clearRect(0, 0, width, height);
    if (!candles || candles.length === 0) return;

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    candles.forEach(c => {
        minPrice = Math.min(minPrice, c.low);
        maxPrice = Math.max(maxPrice, c.high);
    });
    const priceRange = Math.max(maxPrice - minPrice, 0.50);

    // Grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let y = 30; y < height; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }

    const candleWidth = Math.max(4, (width / candles.length) - 4);
    candles.forEach((c, idx) => {
        const x = idx * (width / candles.length) + (candleWidth / 2);
        const yOpen = height - ((c.open - minPrice) / priceRange) * (height - 30) - 15;
        const yClose = height - ((c.close - minPrice) / priceRange) * (height - 30) - 15;
        const yHigh = height - ((c.high - minPrice) / priceRange) * (height - 30) - 15;
        const yLow = height - ((c.low - minPrice) / priceRange) * (height - 30) - 15;

        const isGreen = c.close >= c.open;
        ctx.strokeStyle = isGreen ? '#10b981' : '#ef4444';
        ctx.fillStyle = isGreen ? '#10b981' : '#ef4444';

        // Wick
        ctx.beginPath();
        ctx.moveTo(x, yHigh);
        ctx.lineTo(x, yLow);
        ctx.lineWidth = 1;
        ctx.stroke();

        // Body
        const top = Math.min(yOpen, yClose);
        const bodyHeight = Math.max(Math.abs(yClose - yOpen), 2);
        ctx.fillRect(x - candleWidth / 2, top, candleWidth, bodyHeight);
    });
}

// In-Browser Benchmark Profiler
document.getElementById('btn-start-profiler').addEventListener('click', () => {
    const btn = document.getElementById('btn-start-profiler');
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
            const type = Math.random() > 0.88 ? 'MARKET' : 'LIMIT';

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

        document.getElementById('res-tps').textContent = `${tps.toLocaleString()} ops/s`;
        document.getElementById('res-avg').textContent = `${avg} µs`;
        document.getElementById('res-p50').textContent = `${p50} µs`;
        document.getElementById('res-p99').textContent = `${p99} µs`;

        document.getElementById('profiler-stats-grid').style.display = 'grid';
        btn.textContent = 'RUN AGAIN';
        btn.disabled = false;
    }, 50);
});

// Periodic Cycle
fetchSnapshot();
fetchTrades();
fetchStats();
renderOpenOrders();
setInterval(() => {
    fetchSnapshot();
    fetchTrades();
    fetchStats();
}, 200);
