// NexusEngine Terminal Logic & Client-Side In-Memory Matching Core v2.0
let currentSymbol = 'NIFTY50';
let currentSide = 'BUY';
let currentViewTab = 'depth'; // 'depth' or 'candle'
let currentTickSize = 0.05;
let isAutoMMRunning = false;
let autoMMInterval = null;
let useLocalServer = true;
let isAudioEnabled = true;

// Web Audio API Sound Synthesizer
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function playTradeSound() {
    if (!isAudioEnabled) return;
    try {
        if (!audioCtx) audioCtx = new AudioCtx();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, audioCtx.currentTime); // A5 note
        osc.frequency.exponentialRampToValueAtTime(1760, audioCtx.currentTime + 0.08); // A6 chime
        gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.08);
    } catch (e) {}
}

function playClickSound() {
    if (!isAudioEnabled) return;
    try {
        if (!audioCtx) audioCtx = new AudioCtx();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(320, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.03, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.04);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.04);
    } catch (e) {}
}

// Client-Side In-Memory Order Book Engine
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
        for (let i = 1; i <= 8; i++) {
            this.addOrder('BUY', 'LIMIT', mid - (i * 20), 50 * i);
            this.addOrder('SELL', 'LIMIT', mid + (i * 20), 40 * i);
        }
    }

    seedCandles() {
        let base = this.symbol === 'NIFTY50' ? 195.00 : this.symbol === 'BANKNIFTY' ? 442.00 : 250.00;
        const now = Date.now() - 30 * 60000;
        for (let i = 0; i < 25; i++) {
            const open = base;
            const high = open + Math.random() * 0.40;
            const low = open - Math.random() * 0.40;
            const close = (Math.random() > 0.5) ? high - Math.random() * 0.20 : low + Math.random() * 0.20;
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
            if (this.candles.length > 40) this.candles.shift();
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

        // FIX Log Entry for Inbound New Order (35=D)
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
                            // Iceberg Replenish
                            const replenish = Math.min(maker.displayQty, maker.hiddenQty);
                            maker.hiddenQty -= replenish;
                            maker.remainingQty = replenish;
                            level.totalQty += replenish;
                            level.orders.shift();
                            level.orders.push(maker); // Moves to tail of price level
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
            const order = { id, clientId, side, price, remainingQty: visibleQty, displayQty: visibleQty, hiddenQty };
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
        if (this.fixMessages.length > 60) this.fixMessages.pop();
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

// DOM Elements
const symbolBtns = document.querySelectorAll('.symbol-btn');
const btnBuy = document.getElementById('btn-buy');
const btnSell = document.getElementById('btn-sell');
const orderForm = document.getElementById('order-form');
const orderTypeSelect = document.getElementById('order-type');
const stpModeSelect = document.getElementById('stp-mode');
const priceGroup = document.getElementById('price-group');
const orderPriceInput = document.getElementById('order-price');
const orderQtyInput = document.getElementById('order-qty');
const icebergQtyInput = document.getElementById('iceberg-qty');
const submitBtn = document.getElementById('submit-order-btn');
const tickSizeSelect = document.getElementById('tick-size-select');
const workingOrdersList = document.getElementById('working-orders-list');
const workingCount = document.getElementById('working-count');

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

const depthCanvas = document.getElementById('depth-canvas');
const ctx = depthCanvas.getContext('2d');

const tabDepth = document.getElementById('tab-depth');
const tabCandle = document.getElementById('tab-candle');

// Audio Toggle
const audioToggleBtn = document.getElementById('audio-toggle-btn');
audioToggleBtn.addEventListener('click', () => {
    isAudioEnabled = !isAudioEnabled;
    audioToggleBtn.textContent = isAudioEnabled ? '🔊 Audio ON' : '🔇 Audio MUTED';
    audioToggleBtn.style.opacity = isAudioEnabled ? '1' : '0.5';
});

// Modals
const archModal = document.getElementById('arch-modal');
const benchModal = document.getElementById('bench-modal');
const fixModal = document.getElementById('fix-modal');
const fixStreamContainer = document.getElementById('fix-stream-container');

document.getElementById('open-arch-btn').addEventListener('click', () => archModal.classList.add('show'));
document.getElementById('close-arch-btn').addEventListener('click', () => archModal.classList.remove('show'));
document.getElementById('open-bench-btn').addEventListener('click', () => benchModal.classList.add('show'));
document.getElementById('close-bench-btn').addEventListener('click', () => benchModal.classList.remove('show'));
document.getElementById('open-fix-btn').addEventListener('click', () => {
    fixModal.classList.add('show');
    renderFIXStream();
});
document.getElementById('close-fix-btn').addEventListener('click', () => fixModal.classList.remove('show'));

// Tabs
tabDepth.addEventListener('click', () => {
    currentViewTab = 'depth';
    tabDepth.classList.add('active');
    tabCandle.classList.remove('active');
    fetchSnapshot();
});
tabCandle.addEventListener('click', () => {
    currentViewTab = 'candle';
    tabCandle.classList.add('active');
    tabDepth.classList.remove('active');
    fetchSnapshot();
});

tickSizeSelect.addEventListener('change', (e) => {
    currentTickSize = parseFloat(e.target.value);
    fetchSnapshot();
});

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
    orderPriceInput.value = (parseFloat(orderPriceInput.value) + currentTickSize).toFixed(2);
});
document.getElementById('price-down').addEventListener('click', () => {
    orderPriceInput.value = Math.max(0.01, parseFloat(orderPriceInput.value) - currentTickSize).toFixed(2);
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
    renderWorkingOrders();
});

// Cancel Order action
window.cancelOrder = function(id) {
    playClickSound();
    clientBooks[currentSymbol].cancelOrder(id);
    fetchSnapshot();
    renderWorkingOrders();
};

function renderWorkingOrders() {
    const list = clientBooks[currentSymbol].userWorkingOrders;
    workingCount.textContent = list.length;
    if (list.length === 0) {
        workingOrdersList.innerHTML = '<div class="empty-orders-msg">No resting orders in queue</div>';
        return;
    }
    let html = '';
    list.forEach(o => {
        const sideClass = o.side === 'BUY' ? 'buy-item' : 'sell-item';
        html += `
            <div class="working-order-item ${sideClass}">
                <span><strong>${o.side}</strong> ${o.qty} @ $${(o.price / 100).toFixed(2)}</span>
                <button class="cancel-ord-btn" onclick="cancelOrder(${o.id})">Cancel</button>
            </div>
        `;
    });
    workingOrdersList.innerHTML = html;
}

// HFT Burst Simulation
document.getElementById('sim-burst-100').addEventListener('click', () => runHFTBurst(100));
document.getElementById('sim-burst-1000').addEventListener('click', () => runHFTBurst(1000));

async function runHFTBurst(count) {
    playClickSound();
    const mid = parseFloat(orderPriceInput.value);
    for (let i = 0; i < count; i++) {
        const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
        const offset = (Math.floor(Math.random() * 20) - 10) * currentTickSize;
        const price = Math.round((mid + offset) * 100);
        const qty = Math.floor(Math.random() * 150) + 10;
        const type = Math.random() > 0.88 ? 'MARKET' : 'LIMIT';

        clientBooks[currentSymbol].addOrder(side, type, price, qty);
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

function fetchSnapshot() {
    const data = clientBooks[currentSymbol].getSnapshot(12, currentTickSize);
    renderOrderBook(data);
    if (currentViewTab === 'depth') {
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

function renderFIXStream() {
    const list = clientBooks[currentSymbol].fixMessages;
    let html = '';
    list.forEach(m => {
        const parts = m.raw.split('|');
        const formatted = parts.map(p => `<span class="fix-tag">${p}</span>`).join('<span class="fix-delim">|</span>');
        html += `<div class="fix-log-entry"><span class="text-muted">[${m.time}]</span> ${formatted}</div>`;
    });
    fixStreamContainer.innerHTML = html;
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

function drawCandlestickChart(candles) {
    const width = depthCanvas.width;
    const height = depthCanvas.height;
    ctx.clearRect(0, 0, width, height);
    if (!candles || candles.length === 0) return;

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    candles.forEach(c => {
        minPrice = Math.min(minPrice, c.low);
        maxPrice = Math.max(maxPrice, c.high);
    });
    const priceRange = Math.max(maxPrice - minPrice, 0.50);

    const candleWidth = Math.max(4, (width / candles.length) - 4);
    candles.forEach((c, idx) => {
        const x = idx * (width / candles.length) + (candleWidth / 2);
        const yOpen = height - ((c.open - minPrice) / priceRange) * (height - 30) - 15;
        const yClose = height - ((c.close - minPrice) / priceRange) * (height - 30) - 15;
        const yHigh = height - ((c.high - minPrice) / priceRange) * (height - 30) - 15;
        const yLow = height - ((c.low - minPrice) / priceRange) * (height - 30) - 15;

        const isGreen = c.close >= c.open;
        ctx.strokeStyle = isGreen ? '#00f59b' : '#ff3366';
        ctx.fillStyle = isGreen ? '#00f59b' : '#ff3366';

        // Draw Wick
        ctx.beginPath();
        ctx.moveTo(x, yHigh);
        ctx.lineTo(x, yLow);
        ctx.lineWidth = 1;
        ctx.stroke();

        // Draw Body
        const top = Math.min(yOpen, yClose);
        const bodyHeight = Math.max(Math.abs(yClose - yOpen), 2);
        ctx.fillRect(x - candleWidth / 2, top, candleWidth, bodyHeight);
    });
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
renderWorkingOrders();
setInterval(() => {
    fetchSnapshot();
    fetchTrades();
    fetchStats();
}, 200);
