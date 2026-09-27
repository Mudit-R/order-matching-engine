// NexusEngine Core Controller & In-Memory Matching Engine v2.5 (Robinhood Edition)
let currentSymbol = 'NIFTY50';
let currentSide = 'BUY';
let currentChartTab = 'line'; // 'line', 'candle', 'depth'
let currentTimeframe = '1D';
let currentTickSize = 0.05;
let isAutoMMRunning = false;
let autoMMInterval = null;
let isAudioEnabled = true;

// Web Audio API Synthesizer (Professional Subtle Feedback)
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
        osc.frequency.exponentialRampToValueAtTime(1760, audioCtx.currentTime + 0.04);
        gain.gain.setValueAtTime(0.03, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.04);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.04);
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
        gain.gain.setValueAtTime(0.02, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.03);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.03);
    } catch (e) {}
}

// In-Memory Double-Auction Limit Order Book
class ClientOrderBook {
    constructor(symbol) {
        this.symbol = symbol;
        this.bids = new Map();
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
        for (let i = 1; i <= 9; i++) {
            this.addOrder('BUY', 'LIMIT', mid - (i * 20), 40 * i);
            this.addOrder('SELL', 'LIMIT', mid + (i * 20), 35 * i);
        }
    }

    seedCandles() {
        let base = this.symbol === 'NIFTY50' ? 195.00 : this.symbol === 'BANKNIFTY' ? 442.00 : 250.00;
        const now = Date.now() - 40 * 60000;
        for (let i = 0; i < 40; i++) {
            const open = base;
            const delta = (Math.random() - 0.48) * 0.70;
            const close = Math.round((open + delta) * 100) / 100;
            const high = Math.round((Math.max(open, close) + Math.random() * 0.35) * 100) / 100;
            const low = Math.round((Math.min(open, close) - Math.random() * 0.35) * 100) / 100;
            const vol = Math.floor(Math.random() * 300) + 40;
            this.candles.push({
                time: now + i * 60000,
                open, high, low, close, vol
            });
            base = close;
        }
    }

    updateCandles(tradePrice, tradeQty) {
        const p = tradePrice / 100.0;
        if (this.candles.length === 0) return;
        const last = this.candles[this.candles.length - 1];
        const now = Date.now();
        if (now - last.time > 60000) {
            this.candles.push({ time: now, open: p, high: p, low: p, close: p, vol: tradeQty });
            if (this.candles.length > 50) this.candles.shift();
        } else {
            last.high = Math.max(last.high, p);
            last.low = Math.min(last.low, p);
            last.close = p;
            last.vol = (last.vol || 0) + tradeQty;
        }
    }

    addOrder(side, type, price, qty, displayQty = 0, stp = 'NONE', isUserOrder = false) {
        this.processedOrders++;
        const id = ++this.orderIdGen;
        const clientId = isUserOrder ? 999 : this.clientIdGen++;
        let remaining = qty;
        let visibleQty = (displayQty > 0 && displayQty < qty) ? displayQty : qty;
        let hiddenQty = (displayQty > 0 && displayQty < qty) ? (qty - displayQty) : 0;

        // FIX Log (35=D NewOrderSingle)
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
                        ts: Date.now()
                    });
                    if (this.recentTrades.length > 40) this.recentTrades.pop();

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
                        ts: Date.now()
                    });
                    if (this.recentTrades.length > 40) this.recentTrades.pop();

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
            const order = { id, clientId, side, price, remainingQty: visibleQty, displayQty: visibleQty, hiddenQty, type, stp };
            this.orderIndex.set(id, order);
            const targetMap = side === 'BUY' ? this.bids : this.asks;
            if (!targetMap.has(price)) {
                targetMap.set(price, { totalQty: 0, orders: [] });
            }
            const lvl = targetMap.get(price);
            lvl.orders.push(order);
            lvl.totalQty += visibleQty;

            if (isUserOrder) {
                this.userWorkingOrders.push({ id, side, price, qty: remaining, type, stp });
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
        if (this.fixMessages.length > 50) this.fixMessages.pop();
    }

    getBestBid() {
        const keys = Array.from(this.bids.keys());
        return keys.length > 0 ? Math.max(...keys) : 0;
    }

    getBestAsk() {
        const keys = Array.from(this.asks.keys());
        return keys.length > 0 ? Math.min(...keys) : 0;
    }

    getSnapshot(maxDepth = 10, tickAggregation = 0.05) {
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
const btnSideBuy = document.getElementById('btn-side-buy');
const btnSideSell = document.getElementById('btn-side-sell');
const orderForm = document.getElementById('order-form');
const orderTypeSelect = document.getElementById('order-type');
const stpModeSelect = document.getElementById('stp-mode');
const orderPriceInput = document.getElementById('order-price');
const orderQtyInput = document.getElementById('order-qty');
const icebergQtyInput = document.getElementById('iceberg-qty');
const executeBtn = document.getElementById('execute-btn');
const selectTickSize = document.getElementById('select-tick-size');

const asksLadder = document.getElementById('asks-ladder');
const bidsLadder = document.getElementById('bids-ladder');
const midPriceTxt = document.getElementById('mid-price-txt');
const spreadAmountTxt = document.getElementById('spread-amount-txt');

const statTotalOrders = document.getElementById('stat-total-orders');
const statTotalTrades = document.getElementById('stat-total-trades');
const tradesStream = document.getElementById('trades-stream');
const workingOrdersStream = document.getElementById('working-orders-stream');
const workingCount = document.getElementById('working-count');
const fixFeedBody = document.getElementById('fix-feed-body');

const tabChartLine = document.getElementById('tab-chart-line');
const tabChartCandle = document.getElementById('tab-chart-candle');
const tabChartDepth = document.getElementById('tab-chart-depth');

const heroPriceEl = document.getElementById('hero-display-price');
const heroChangeEl = document.getElementById('hero-display-change');
const activeAssetTitle = document.getElementById('active-asset-title');

const tradingCanvas = document.getElementById('trading-canvas');
const ctx = tradingCanvas.getContext('2d');

// Mouse tracking for Robinhood interactive crosshair
let mousePos = { x: -1, y: -1, active: false };

tradingCanvas.addEventListener('mousemove', (e) => {
    const rect = tradingCanvas.getBoundingClientRect();
    mousePos.x = e.clientX - rect.left;
    mousePos.y = e.clientY - rect.top;
    mousePos.active = true;
    renderCurrentChart();
});

tradingCanvas.addEventListener('mouseleave', () => {
    mousePos.active = false;
    renderCurrentChart();
});

// Modals
const modalFix = document.getElementById('modal-fix');
const modalBench = document.getElementById('modal-bench');
const btnOpenFix = document.getElementById('btn-open-fix');
const btnOpenBench = document.getElementById('btn-open-bench');
const closeModalFix = document.getElementById('close-modal-fix');
const closeModalBench = document.getElementById('close-modal-bench');

if (btnOpenFix) btnOpenFix.addEventListener('click', () => { modalFix.classList.add('show'); renderFIX(); });
if (closeModalFix) closeModalFix.addEventListener('click', () => modalFix.classList.remove('show'));
if (btnOpenBench) btnOpenBench.addEventListener('click', () => modalBench.classList.add('show'));
if (closeModalBench) closeModalBench.addEventListener('click', () => modalBench.classList.remove('show'));

window.addEventListener('click', (e) => {
    if (e.target === modalFix) modalFix.classList.remove('show');
    if (e.target === modalBench) modalBench.classList.remove('show');
});

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (modalFix) modalFix.classList.remove('show');
        if (modalBench) modalBench.classList.remove('show');
    }
});

// Audio Toggle
const btnToggleAudio = document.getElementById('btn-toggle-audio');
if (btnToggleAudio) {
    btnToggleAudio.addEventListener('click', () => {
        isAudioEnabled = !isAudioEnabled;
        btnToggleAudio.textContent = isAudioEnabled ? 'Audio: ON' : 'Audio: MUTED';
    });
}

// Chart Mode Tabs
function setActiveChartTab(tab) {
    currentChartTab = tab;
    [tabChartLine, tabChartCandle, tabChartDepth].forEach(btn => {
        if (btn) btn.classList.remove('active');
    });
    if (tab === 'line' && tabChartLine) tabChartLine.classList.add('active');
    if (tab === 'candle' && tabChartCandle) tabChartCandle.classList.add('active');
    if (tab === 'depth' && tabChartDepth) tabChartDepth.classList.add('active');
    renderCurrentChart();
}

if (tabChartLine) tabChartLine.addEventListener('click', () => setActiveChartTab('line'));
if (tabChartCandle) tabChartCandle.addEventListener('click', () => setActiveChartTab('candle'));
if (tabChartDepth) tabChartDepth.addEventListener('click', () => setActiveChartTab('depth'));

// Timeframe selector pills
document.querySelectorAll('.timeframe-pill').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.timeframe-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTimeframe = btn.getAttribute('data-tf') || '1D';
        renderCurrentChart();
    });
});

if (selectTickSize) {
    selectTickSize.addEventListener('change', (e) => {
        currentTickSize = parseFloat(e.target.value);
        fetchSnapshot();
    });
}

function resizeCanvas() {
    if (tradingCanvas && tradingCanvas.parentElement) {
        const rect = tradingCanvas.parentElement.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            tradingCanvas.width = Math.floor(rect.width);
            tradingCanvas.height = Math.floor(rect.height);
            renderCurrentChart();
        }
    }
}
window.addEventListener('resize', resizeCanvas);
setTimeout(resizeCanvas, 50);

// Side Toggle (Buy / Sell)
function setOrderSide(side) {
    currentSide = side;
    if (side === 'BUY') {
        if (btnSideBuy) btnSideBuy.className = 'side-pill-btn active-buy';
        if (btnSideSell) btnSideSell.className = 'side-pill-btn';
        if (executeBtn) {
            executeBtn.className = 'btn-transmit buy-mode';
            const span = executeBtn.querySelector('span');
            if (span) span.textContent = `Review Buy Order`;
        }
    } else {
        if (btnSideSell) btnSideSell.className = 'side-pill-btn active-sell';
        if (btnSideBuy) btnSideBuy.className = 'side-pill-btn';
        if (executeBtn) {
            executeBtn.className = 'btn-transmit sell-mode';
            const span = executeBtn.querySelector('span');
            if (span) span.textContent = `Review Sell Order`;
        }
    }
    updateOrderSummary();
}

if (btnSideBuy) btnSideBuy.addEventListener('click', () => setOrderSide('BUY'));
if (btnSideSell) btnSideSell.addEventListener('click', () => setOrderSide('SELL'));

// Price Steppers
const stepUpBtn = document.getElementById('step-price-up');
const stepDownBtn = document.getElementById('step-price-down');
if (stepUpBtn && orderPriceInput) {
    stepUpBtn.addEventListener('click', () => {
        orderPriceInput.value = (parseFloat(orderPriceInput.value || 0) + currentTickSize).toFixed(2);
        updateOrderSummary();
    });
}
if (stepDownBtn && orderPriceInput) {
    stepDownBtn.addEventListener('click', () => {
        orderPriceInput.value = Math.max(0.01, parseFloat(orderPriceInput.value || 0) - currentTickSize).toFixed(2);
        updateOrderSummary();
    });
}

// Percentage Buttons (25%, 50%, 75%, 100%)
document.querySelectorAll('.pct-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const pct = parseFloat(btn.getAttribute('data-pct'));
        const qty = Math.max(10, Math.round(500 * pct));
        if (orderQtyInput) {
            orderQtyInput.value = qty;
            updateOrderSummary();
        }
    });
});

// Symbol Dropdown Selector
const symbolSelect = document.getElementById('symbol-select');
if (symbolSelect) {
    symbolSelect.addEventListener('change', (e) => {
        switchSymbol(e.target.value);
    });
}

function switchSymbol(symbol) {
    if (!clientBooks[symbol]) return;
    currentSymbol = symbol;
    if (activeAssetTitle) activeAssetTitle.textContent = symbol === 'NIFTY50' ? 'NIFTY 50' : symbol === 'BANKNIFTY' ? 'BANK NIFTY' : 'RELIANCE IND';
    const basePrice = symbol === 'NIFTY50' ? '195.00' : symbol === 'BANKNIFTY' ? '442.00' : '250.00';
    if (orderPriceInput) orderPriceInput.value = basePrice;
    setOrderSide(currentSide);
    fetchSnapshot();
    renderWorkingOrders();
}

// Order Type Selection
document.querySelectorAll('.type-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.type-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const type = tab.getAttribute('data-type');
        if (orderTypeSelect) orderTypeSelect.value = type;

        const icebergGroup = document.getElementById('iceberg-input-group');
        if (icebergGroup) {
            icebergGroup.style.display = (type === 'ICEBERG') ? 'flex' : 'none';
        }

        const priceCell = document.getElementById('price-input-cell');
        if (priceCell) {
            priceCell.style.opacity = (type === 'MARKET') ? '0.4' : '1';
            priceCell.style.pointerEvents = (type === 'MARKET') ? 'none' : 'auto';
        }
        updateOrderSummary();
    });
});

function updateOrderSummary() {
    const p = parseFloat(orderPriceInput ? orderPriceInput.value : 0) || 0;
    const q = parseFloat(orderQtyInput ? orderQtyInput.value : 0) || 0;
    const val = (p * q).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const lbl = document.getElementById('summary-order-value');
    if (lbl) lbl.textContent = `$${val} USD`;
}

if (orderPriceInput) orderPriceInput.addEventListener('input', updateOrderSummary);
if (orderQtyInput) orderQtyInput.addEventListener('input', updateOrderSummary);

// Submit Order
if (orderForm) {
    orderForm.addEventListener('submit', (e) => {
        e.preventDefault();
        playClickSound();
        const type = orderTypeSelect ? orderTypeSelect.value : 'LIMIT';
        const stp = stpModeSelect ? stpModeSelect.value : 'NONE';
        const priceCents = Math.round(parseFloat(orderPriceInput.value) * 100);
        const qty = parseInt(orderQtyInput.value, 10);
        const displayQty = (icebergQtyInput && icebergQtyInput.value) ? parseInt(icebergQtyInput.value, 10) : 0;

        clientBooks[currentSymbol].addOrder(currentSide, type, priceCents, qty, displayQty, stp, true);
        fetchSnapshot();
        fetchTrades();
        fetchStats();
        renderWorkingOrders();
    });
}

// Cancel Order
window.cancelOrder = function(id) {
    playClickSound();
    clientBooks[currentSymbol].cancelOrder(id);
    fetchSnapshot();
    renderWorkingOrders();
    renderFIX();
};

function renderWorkingOrders() {
    const list = clientBooks[currentSymbol].userWorkingOrders;
    if (workingCount) workingCount.textContent = list.length;
    if (!workingOrdersStream) return;

    if (list.length === 0) {
        workingOrdersStream.innerHTML = '<tr><td colspan="7" class="empty-state">No active working orders on the book</td></tr>';
        return;
    }
    let html = '';
    list.forEach(o => {
        const isBuy = o.side === 'BUY';
        const sideColor = isBuy ? 'var(--color-buy)' : 'var(--color-sell)';
        const timeStr = new Date().toLocaleTimeString();
        html += `
            <tr>
                <td>${timeStr}</td>
                <td style="color:${sideColor}; font-weight:700;">${o.side}</td>
                <td>${o.type}</td>
                <td class="mono">$${(o.price / 100).toFixed(2)}</td>
                <td class="mono">${o.qty}</td>
                <td>${o.stp || 'None'}</td>
                <td><button class="btn-cancel-order" onclick="cancelOrder(${o.id})">Cancel</button></td>
            </tr>
        `;
    });
    workingOrdersStream.innerHTML = html;
}

// Burst Simulation
const btnBurst1000 = document.getElementById('btn-burst-1000');
if (btnBurst1000) {
    btnBurst1000.addEventListener('click', () => runBurst(1000));
}

function runBurst(count) {
    playClickSound();
    const mid = parseFloat(orderPriceInput ? orderPriceInput.value : 195);
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

// Auto Simulator
const btnToggleSim = document.getElementById('btn-toggle-sim');
if (btnToggleSim) {
    btnToggleSim.addEventListener('click', () => {
        isAutoMMRunning = !isAutoMMRunning;
        if (isAutoMMRunning) {
            btnToggleSim.textContent = 'Auto MM: ON';
            btnToggleSim.classList.add('active-sim');
            autoMMInterval = setInterval(() => runBurst(15), 180);
        } else {
            btnToggleSim.textContent = 'Auto MM: OFF';
            btnToggleSim.classList.remove('active-sim');
            clearInterval(autoMMInterval);
        }
    });
}

function fetchSnapshot() {
    const data = clientBooks[currentSymbol].getSnapshot(10, currentTickSize);
    renderOrderBook(data);
    renderCurrentChart();
}

function renderCurrentChart() {
    const book = clientBooks[currentSymbol];
    if (currentChartTab === 'depth') {
        drawDepthChart(book.getSnapshot(12, currentTickSize));
    } else if (currentChartTab === 'candle') {
        drawCandlestickChart(book.candles);
    } else {
        drawRobinhoodLineChart(book.candles);
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
    if (statTotalOrders) statTotalOrders.textContent = totalOrders.toLocaleString();
    if (statTotalTrades) statTotalTrades.textContent = totalTrades.toLocaleString();
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
    const mid = (data.best_bid && data.best_ask) ? ((data.best_bid + data.best_ask) / 200).toFixed(2) : '195.00';

    if (midPriceTxt) midPriceTxt.textContent = `$${mid}`;
    if (spreadAmountTxt) spreadAmountTxt.textContent = `${spread}`;

    if (heroPriceEl) heroPriceEl.textContent = `$${mid}`;
    if (heroChangeEl) heroChangeEl.textContent = `+$4.20 (+2.15%) Today`;

    // Asks Ladder (Red)
    let askRows = '';
    let runAsk = 0;
    const revAsks = [...asks].slice(0, 8).reverse();
    revAsks.forEach(a => {
        runAsk += a.qty;
        const pct = Math.min(100, Math.round((runAsk / maxCumulative) * 100));
        askRows += `
            <div class="ob-row ask" onclick="fillPrice(${a.price / 100})">
                <span class="ob-row-val price-val">$${(a.price / 100).toFixed(2)}</span>
                <span class="ob-row-val text-right mono">${a.qty}</span>
                <span class="ob-row-val text-right mono text-muted">${runAsk}</span>
                <div class="depth-bar ask-bar" style="width: ${pct}%"></div>
            </div>
        `;
    });
    if (asksLadder) asksLadder.innerHTML = askRows;

    // Bids Ladder (Green)
    let bidRows = '';
    let runBid = 0;
    bids.slice(0, 8).forEach(b => {
        runBid += b.qty;
        const pct = Math.min(100, Math.round((runBid / maxCumulative) * 100));
        bidRows += `
            <div class="ob-row bid" onclick="fillPrice(${b.price / 100})">
                <span class="ob-row-val price-val">$${(b.price / 100).toFixed(2)}</span>
                <span class="ob-row-val text-right mono">${b.qty}</span>
                <span class="ob-row-val text-right mono text-muted">${runBid}</span>
                <div class="depth-bar bid-bar" style="width: ${pct}%"></div>
            </div>
        `;
    });
    if (bidsLadder) bidsLadder.innerHTML = bidRows;
}

window.fillPrice = function(price) {
    if (orderPriceInput) {
        orderPriceInput.value = price.toFixed(2);
        updateOrderSummary();
    }
};

function renderTrades(trades) {
    if (!trades) return;
    let tapeHtml = '';
    let blotterHtml = '';

    trades.slice(0, 16).forEach(t => {
        const timeStr = new Date(t.ts).toLocaleTimeString();
        const isBuy = t.side === 'BUY';
        const sideClass = isBuy ? 'buy' : 'sell';
        const sideColor = isBuy ? 'var(--color-buy)' : 'var(--color-sell)';

        tapeHtml += `
            <div class="trade-row ${sideClass}">
                <span class="t-price mono">$${(t.price / 100).toFixed(2)}</span>
                <span class="text-right mono">${t.qty}</span>
                <span class="text-right t-time mono text-muted">${timeStr}</span>
            </div>
        `;

        blotterHtml += `
            <tr>
                <td>${timeStr}</td>
                <td style="color:${sideColor}; font-weight:700;">${t.side}</td>
                <td class="mono">$${(t.price / 100).toFixed(2)}</td>
                <td class="mono">${t.qty}</td>
                <td>FIFO Match</td>
                <td>0.16 µs</td>
            </tr>
        `;
    });

    if (tradesStream) tradesStream.innerHTML = tapeHtml;
    const blotterStream = document.getElementById('blotter-trades-stream');
    if (blotterStream && blotterHtml) blotterStream.innerHTML = blotterHtml;
}

function renderFIX() {
    const list = clientBooks[currentSymbol].fixMessages;
    let html = '';
    list.forEach(m => {
        const parts = m.raw.split('|');
        const formatted = parts.map(p => `<span class="f-tag">${p}</span>`).join('|');
        html += `<div class="fix-row"><span class="fix-time">[${m.time}]</span> ${formatted}</div>`;
    });
    if (fixFeedBody) fixFeedBody.innerHTML = html;
    const inlineFix = document.getElementById('inline-fix-feed');
    if (inlineFix) inlineFix.innerHTML = html;
}

// 1. Signature Robinhood Glowing Area Chart
function drawRobinhoodLineChart(candles) {
    if (!tradingCanvas || !tradingCanvas.parentElement) return;
    const width = tradingCanvas.width;
    const height = tradingCanvas.height;
    ctx.clearRect(0, 0, width, height);

    // Pure obsidian background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    if (!candles || candles.length === 0) return;

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    candles.forEach(c => {
        minPrice = Math.min(minPrice, c.low);
        maxPrice = Math.max(maxPrice, c.high);
    });

    const priceRange = Math.max(maxPrice - minPrice, 0.40);
    const topMargin = 25;
    const bottomMargin = 35;
    const rightMargin = 70;
    const drawWidth = width - rightMargin;
    const chartHeight = height - topMargin - bottomMargin;

    // Subtle horizontal price grid lines
    ctx.strokeStyle = '#14181f';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#656f7d';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'left';

    const steps = 4;
    for (let i = 0; i <= steps; i++) {
        const y = topMargin + (i / steps) * chartHeight;
        const p = maxPrice - (i / steps) * priceRange;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(drawWidth, y);
        ctx.stroke();
        ctx.fillText(`$${p.toFixed(2)}`, drawWidth + 8, y + 3.5);
    }

    // Points calculation
    const points = candles.map((c, idx) => {
        const x = (idx / (candles.length - 1)) * drawWidth;
        const y = topMargin + (1 - (c.close - minPrice) / priceRange) * chartHeight;
        return { x, y, price: c.close, time: c.time };
    });

    // Area Gradient Fill under Robinhood Curve
    const areaGrad = ctx.createLinearGradient(0, topMargin, 0, height - bottomMargin);
    areaGrad.addColorStop(0, 'rgba(0, 200, 5, 0.22)');
    areaGrad.addColorStop(0.7, 'rgba(0, 200, 5, 0.04)');
    areaGrad.addColorStop(1, 'rgba(0, 200, 5, 0.0)');

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        // Smooth Bezier Curve
        const prev = points[i - 1];
        const curr = points[i];
        const midX = (prev.x + curr.x) / 2;
        ctx.bezierCurveTo(midX, prev.y, midX, curr.y, curr.x, curr.y);
    }
    ctx.lineTo(drawWidth, height - bottomMargin);
    ctx.lineTo(0, height - bottomMargin);
    ctx.closePath();
    ctx.fillStyle = areaGrad;
    ctx.fill();

    // Vibrant Robinhood Green Stroke Line
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const midX = (prev.x + curr.x) / 2;
        ctx.bezierCurveTo(midX, prev.y, midX, curr.y, curr.x, curr.y);
    }
    ctx.strokeStyle = '#00c805';
    ctx.lineWidth = 2.4;
    ctx.stroke();

    // Dotted Baseline (Previous Close / First Price)
    const basePriceY = topMargin + (1 - (candles[0].open - minPrice) / priceRange) * chartHeight;
    ctx.strokeStyle = '#232931';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, basePriceY);
    ctx.lineTo(drawWidth, basePriceY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Interactive Hover Crosshair & Tooltip
    if (mousePos.active && mousePos.x >= 0 && mousePos.x <= drawWidth) {
        const idx = Math.min(candles.length - 1, Math.max(0, Math.round((mousePos.x / drawWidth) * (candles.length - 1))));
        const hoveredPt = points[idx];

        // Vertical dashed hair
        ctx.strokeStyle = '#434c56';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hoveredPt.x, topMargin);
        ctx.lineTo(hoveredPt.x, height - bottomMargin);
        ctx.stroke();
        ctx.setLineDash([]);

        // Luminous glowing circle at the hovered point
        ctx.beginPath();
        ctx.arc(hoveredPt.x, hoveredPt.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#00c805';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Floating tooltip badge
        const timeStr = new Date(hoveredPt.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const text = `$${hoveredPt.price.toFixed(2)} • ${timeStr}`;
        ctx.font = 'bold 11px JetBrains Mono, monospace';
        const txtWidth = ctx.measureText(text).width + 16;
        let tipX = hoveredPt.x - txtWidth / 2;
        if (tipX < 10) tipX = 10;
        if (tipX + txtWidth > drawWidth - 10) tipX = drawWidth - txtWidth - 10;

        ctx.fillStyle = '#14181f';
        ctx.strokeStyle = '#262f3a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(tipX, 8, txtWidth, 22, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#00c805';
        ctx.fillText(text, tipX + 8, 23);
    }
}

// 2. Candlestick Chart (Robinhood Legend Style)
function drawCandlestickChart(candles) {
    if (!tradingCanvas || !tradingCanvas.parentElement) return;
    const width = tradingCanvas.width;
    const height = tradingCanvas.height;
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    if (!candles || candles.length === 0) return;

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    let maxVol = 1;
    candles.forEach(c => {
        minPrice = Math.min(minPrice, c.low);
        maxPrice = Math.max(maxPrice, c.high);
        if (c.vol) maxVol = Math.max(maxVol, c.vol);
    });

    const priceRange = Math.max(maxPrice - minPrice, 0.40);
    const topMargin = 20;
    const chartHeight = height - 70;
    const rightMargin = 70;
    const drawWidth = width - rightMargin;

    // Grid lines & labels
    ctx.strokeStyle = '#14181f';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#656f7d';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'left';

    const steps = 4;
    for (let i = 0; i <= steps; i++) {
        const y = topMargin + (i / steps) * (chartHeight - topMargin);
        const p = maxPrice - (i / steps) * priceRange;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(drawWidth, y);
        ctx.stroke();
        ctx.fillText(`$${p.toFixed(2)}`, drawWidth + 8, y + 3.5);
    }

    const slotWidth = drawWidth / candles.length;
    const candleWidth = Math.max(3, slotWidth * 0.7);

    // Volume Bars (Bottom)
    const volHeight = 40;
    const volBase = height - 10;
    candles.forEach((c, idx) => {
        const x = idx * slotWidth + (slotWidth / 2);
        const v = c.vol || 50;
        const barH = (v / maxVol) * volHeight;
        const isUp = c.close >= c.open;
        ctx.fillStyle = isUp ? 'rgba(0, 200, 5, 0.28)' : 'rgba(255, 80, 0, 0.28)';
        ctx.fillRect(x - candleWidth / 2, volBase - barH, candleWidth, barH);
    });

    // Candles
    candles.forEach((c, idx) => {
        const x = idx * slotWidth + (slotWidth / 2);
        const yOpen = topMargin + (1 - (c.open - minPrice) / priceRange) * (chartHeight - topMargin);
        const yClose = topMargin + (1 - (c.close - minPrice) / priceRange) * (chartHeight - topMargin);
        const yHigh = topMargin + (1 - (c.high - minPrice) / priceRange) * (chartHeight - topMargin);
        const yLow = topMargin + (1 - (c.low - minPrice) / priceRange) * (chartHeight - topMargin);

        const isGreen = c.close >= c.open;
        const color = isGreen ? '#00c805' : '#ff5000';

        // Wicks
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, yHigh);
        ctx.lineTo(x, yLow);
        ctx.stroke();

        // Body
        ctx.fillStyle = color;
        const top = Math.min(yOpen, yClose);
        const bodyH = Math.max(Math.abs(yClose - yOpen), 1.5);
        ctx.fillRect(x - candleWidth / 2, top, candleWidth, bodyH);
    });

    // Price badge for last candle
    const lastCandle = candles[candles.length - 1];
    const lastY = topMargin + (1 - (lastCandle.close - minPrice) / priceRange) * (chartHeight - topMargin);
    const isUp = lastCandle.close >= lastCandle.open;
    const badgeColor = isUp ? '#00c805' : '#ff5000';

    ctx.strokeStyle = badgeColor;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, lastY);
    ctx.lineTo(drawWidth, lastY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = badgeColor;
    ctx.beginPath();
    ctx.roundRect(drawWidth + 4, lastY - 9, rightMargin - 8, 18, 3);
    ctx.fill();

    ctx.fillStyle = isUp ? '#000000' : '#ffffff';
    ctx.font = 'bold 10px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(lastCandle.close.toFixed(2), drawWidth + 4 + (rightMargin - 8) / 2, lastY + 3.5);
}

// 3. Depth Chart
function drawDepthChart(data) {
    if (!tradingCanvas || !tradingCanvas.parentElement) return;
    const width = tradingCanvas.width;
    const height = tradingCanvas.height;
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    const bids = data.bids || [];
    const asks = data.asks || [];
    if (bids.length === 0 && asks.length === 0) return;

    let bidCum = 0;
    const bidPoints = bids.map(b => { bidCum += b.qty; return { price: b.price / 100, cum: bidCum }; });
    let askCum = 0;
    const askPoints = asks.map(a => { askCum += a.qty; return { price: a.price / 100, cum: askCum }; });
    const maxCum = Math.max(bidCum, askCum, 1);
    const midX = width / 2;

    // Bids (Green)
    ctx.beginPath();
    ctx.moveTo(midX, height - 20);
    for (let i = 0; i < bidPoints.length; i++) {
        const x = midX - ((i + 1) / Math.max(bidPoints.length, 1)) * (width / 2);
        const y = (height - 20) - (bidPoints[i].cum / maxCum) * (height - 60);
        ctx.lineTo(x, y);
    }
    ctx.lineTo(0, height - 20);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 200, 5, 0.18)';
    ctx.fill();
    ctx.strokeStyle = '#00c805';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Asks (Red)
    ctx.beginPath();
    ctx.moveTo(midX, height - 20);
    for (let i = 0; i < askPoints.length; i++) {
        const x = midX + ((i + 1) / Math.max(askPoints.length, 1)) * (width / 2);
        const y = (height - 20) - (askPoints[i].cum / maxCum) * (height - 60);
        ctx.lineTo(x, y);
    }
    ctx.lineTo(width, height - 20);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 80, 0, 0.18)';
    ctx.fill();
    ctx.strokeStyle = '#ff5000';
    ctx.lineWidth = 2;
    ctx.stroke();
}

// 50,000 Order In-Browser Benchmark
const btnStartBenchmark = document.getElementById('btn-start-benchmark');
if (btnStartBenchmark) {
    btnStartBenchmark.addEventListener('click', () => {
        btnStartBenchmark.textContent = 'RUNNING 50,000 MATCHES...';
        btnStartBenchmark.disabled = true;

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

            const bTps = document.getElementById('b-tps');
            const bAvg = document.getElementById('b-avg');
            const bP50 = document.getElementById('b-p50');
            const bP99 = document.getElementById('b-p99');
            if (bTps) bTps.textContent = `${tps.toLocaleString()} ops/s`;
            if (bAvg) bAvg.textContent = `${avg} µs`;
            if (bP50) bP50.textContent = `${p50} µs`;
            if (bP99) bP99.textContent = `${p99} µs`;

            const grid = document.getElementById('bench-stats-grid');
            if (grid) grid.style.display = 'grid';
            btnStartBenchmark.textContent = 'RUN AGAIN';
            btnStartBenchmark.disabled = false;
        }, 50);
    });
}

// Blotter Tabs
document.querySelectorAll('.blotter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.blotter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const tabKey = tab.getAttribute('data-tab');
        ['working', 'trades', 'fix', 'telemetry'].forEach(k => {
            const el = document.getElementById(`view-tab-${k}`);
            if (el) el.style.display = (k === tabKey) ? 'block' : 'none';
        });

        if (tabKey === 'fix') renderFIX();
    });
});

// Initial startup cycle
fetchSnapshot();
fetchTrades();
fetchStats();
renderWorkingOrders();
updateOrderSummary();

// Periodic live cycle
setInterval(() => {
    fetchSnapshot();
    fetchTrades();
    fetchStats();
}, 250);


// =========================================================================
// AUTHENTIC FINTECH, EDUCATIONAL & TOUR ENHANCEMENTS
// =========================================================================

// 1. Toast Notification System
function showToast(badge, title, msg) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
        <span class="toast-badge">${badge}</span>
        <div class="toast-msg">
            <strong>${title}:</strong> ${msg}
        </div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => {
            if (toast.parentElement) toast.parentElement.removeChild(toast);
        }, 260);
    }, 4000);
}

// 2. Dynamic Order Type Explanations
const orderTypeExplainerText = document.getElementById('order-type-explainer-text');
const typeExplanations = {
    'LIMIT': '<strong>Limit Order:</strong> Rests passively on the order book at your specified price. Matches only when crossed by an opposite counter-order.',
    'MARKET': '<strong>Market Order:</strong> Aggressive taker order. Executes immediately across available resting asks/bids at the best available market prices.',
    'ICEBERG': '<strong>Iceberg Order:</strong> Institutional order. Displays only a small visible slice on the public book, automatically replenishing from hidden volume upon fill.',
    'POST_ONLY': '<strong>Post-Only Order:</strong> Maker guarantee. Enters book only if it adds resting liquidity; cancels immediately if it would cross the spread.',
    'IOC': '<strong>Immediate-Or-Cancel:</strong> Fills immediately against available resting liquidity; cancels any remaining unfilled quantity.'
};

document.querySelectorAll('.type-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const type = tab.getAttribute('data-type');
        if (orderTypeExplainerText && typeExplanations[type]) {
            orderTypeExplainerText.innerHTML = typeExplanations[type];
        }
    });
});

// 3. Project Explainer Banner Dismiss
const btnCloseBanner = document.getElementById('btn-close-banner');
const projectBanner = document.getElementById('project-banner');
if (btnCloseBanner && projectBanner) {
    btnCloseBanner.addEventListener('click', () => {
        projectBanner.style.display = 'none';
    });
}

// 4. Guide Modal & Deep Dive Navigation
const modalGuide = document.getElementById('modal-guide');
const closeModalGuide = document.getElementById('close-modal-guide');

function openGuideModal(tabKey = 'overview') {
    if (!modalGuide) return;
    modalGuide.classList.add('show');
    switchGuideTab(tabKey);
}

function switchGuideTab(tabKey) {
    document.querySelectorAll('.guide-nav-tab').forEach(tab => {
        tab.classList.toggle('active', tab.getAttribute('data-guidetab') === tabKey);
    });

    ['overview', 'mechanics', 'ordertypes', 'architecture', 'tour'].forEach(k => {
        const pane = document.getElementById(`pane-guide-${k}`);
        if (pane) pane.style.display = (k === tabKey) ? 'block' : 'none';
    });
}

if (closeModalGuide) closeModalGuide.addEventListener('click', () => modalGuide.classList.remove('show'));

window.addEventListener('click', (e) => {
    if (e.target === modalGuide) modalGuide.classList.remove('show');
});

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalGuide) modalGuide.classList.remove('show');
});

document.querySelectorAll('.guide-nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const key = tab.getAttribute('data-guidetab');
        if (key) switchGuideTab(key);
    });
});

// Header Navigation Links
const navWhyProject = document.getElementById('nav-why-project');
const navHowItWorks = document.getElementById('nav-how-it-works');
const navArchitecture = document.getElementById('nav-architecture');
const btnBannerGuide = document.getElementById('btn-banner-guide');
const btnBannerArch = document.getElementById('btn-banner-arch');

if (navWhyProject) navWhyProject.addEventListener('click', () => openGuideModal('overview'));
if (navHowItWorks) navHowItWorks.addEventListener('click', () => openGuideModal('mechanics'));
if (navArchitecture) navArchitecture.addEventListener('click', () => openGuideModal('architecture'));
if (btnBannerGuide) btnBannerGuide.addEventListener('click', () => openGuideModal('mechanics'));
if (btnBannerArch) btnBannerArch.addEventListener('click', () => openGuideModal('architecture'));

// 5. Interactive Crossing Match Demo
function runCrossingMatchDemo() {
    playClickSound();
    const snap = clientBooks[currentSymbol].getSnapshot(5, currentTickSize);
    let crossPrice = 19520; // default $195.20

    if (snap.best_ask) {
        crossPrice = snap.best_ask;
    } else if (snap.asks && snap.asks.length > 0) {
        crossPrice = snap.asks[0].price;
    }

    const qty = 50;
    clientBooks[currentSymbol].addOrder('BUY', 'LIMIT', crossPrice, qty, 0, 'NONE', true);

    fetchSnapshot();
    fetchTrades();
    fetchStats();
    renderWorkingOrders();

    showToast(
        'DEMO MATCH',
        'Crossing Trade Executed',
        `A BUY order crossed the spread at $${(crossPrice/100).toFixed(2)} and matched against resting Ask liquidity via FIFO priority.`
    );
}

const btnBannerDemo = document.getElementById('btn-banner-demo');
const btnBannerDemoHdr = document.getElementById('btn-banner-demo-hdr');
if (btnBannerDemo) btnBannerDemo.addEventListener('click', runCrossingMatchDemo);
if (btnBannerDemoHdr) btnBannerDemoHdr.addEventListener('click', runCrossingMatchDemo);

// 6. Interactive 4-Step Guided Tour Handlers
const btnTourStep1 = document.getElementById('btn-tour-step1');
const btnTourStep2 = document.getElementById('btn-tour-step2');
const btnTourStep3 = document.getElementById('btn-tour-step3');
const btnTourStep4 = document.getElementById('btn-tour-step4');

if (btnTourStep1) {
    btnTourStep1.addEventListener('click', () => {
        playClickSound();
        if (modalGuide) modalGuide.classList.remove('show');
        // Submit resting Buy below spread
        clientBooks[currentSymbol].addOrder('BUY', 'LIMIT', 19450, 100, 0, 'NONE', true);
        fetchSnapshot();
        renderWorkingOrders();
        showToast('STEP 1: PASSIVE ORDER', 'Resting Limit Placed', 'Submitted Buy 100 @ $194.50. It now rests passively in the green Bids ladder.');
    });
}

if (btnTourStep2) {
    btnTourStep2.addEventListener('click', () => {
        if (modalGuide) modalGuide.classList.remove('show');
        runCrossingMatchDemo();
    });
}

if (btnTourStep3) {
    btnTourStep3.addEventListener('click', () => {
        playClickSound();
        if (modalGuide) modalGuide.classList.remove('show');
        // Submit Iceberg Buy: 500 total, 50 slice
        clientBooks[currentSymbol].addOrder('BUY', 'ICEBERG', 19480, 500, 50, 'NONE', true);
        fetchSnapshot();
        renderWorkingOrders();
        showToast('STEP 3: ICEBERG ORDER', 'Hidden Liquidity Placed', 'Submitted 500 contracts with 50 visible slice @ $194.80. Only 50 shows on the public book!');
    });
}

if (btnTourStep4) {
    btnTourStep4.addEventListener('click', () => {
        if (modalGuide) modalGuide.classList.remove('show');
        if (modalBench) modalBench.classList.add('show');
    });
}
