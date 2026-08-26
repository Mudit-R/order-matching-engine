// NexusCore Tactile Hardware & Low-Latency Matching Engine Controller
let currentSymbol = 'NIFTY50';
let currentSide = 'BUY';
let currentChartTab = 'depth';
let currentTickSize = 0.05;
let isAutoMMRunning = false;
let autoMMInterval = null;
let isAudioEnabled = true;

// Web Audio API Synthesizer
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

// In-Memory Order Book Engine
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
        this.candles = [];
        this.orderIdGen = 1000;
        this.seedInitialBook();
        this.seedCandles();
    }

    seedInitialBook() {
        const mid = 19500;
        for (let i = 1; i <= 8; i++) {
            this.addOrder('BUY', 'LIMIT', mid - (i * 20), 50 * i);
            this.addOrder('SELL', 'LIMIT', mid + (i * 20), 40 * i);
        }
    }

    seedCandles() {
        let base = 195.00;
        const now = Date.now() - 30 * 60000;
        for (let i = 0; i < 30; i++) {
            const open = base;
            const high = open + Math.random() * 0.35;
            const low = open - Math.random() * 0.35;
            const close = (Math.random() > 0.5) ? high - Math.random() * 0.15 : low + Math.random() * 0.15;
            const volume = Math.floor(Math.random() * 5000) + 1000;
            this.candles.push({ time: now + i * 60000, open, high, low, close, volume });
            base = close;
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
                    const matchQty = Math.min(remaining, maker.remainingQty);
                    remaining -= matchQty;
                    maker.remainingQty -= matchQty;
                    level.totalQty -= matchQty;

                    this.executedTrades++;
                    playTradeSound();

                    this.recentTrades.unshift({
                        maker: maker.id,
                        taker: id,
                        price: askPrice,
                        qty: matchQty,
                        side: 'BUY',
                        ts: Date.now() * 1000000
                    });
                    if (this.recentTrades.length > 40) this.recentTrades.pop();

                    if (maker.remainingQty <= 0) {
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
                    const matchQty = Math.min(remaining, maker.remainingQty);
                    remaining -= matchQty;
                    maker.remainingQty -= matchQty;
                    level.totalQty -= matchQty;

                    this.executedTrades++;
                    playTradeSound();

                    this.recentTrades.unshift({
                        maker: maker.id,
                        taker: id,
                        price: bidPrice,
                        qty: matchQty,
                        side: 'SELL',
                        ts: Date.now() * 1000000
                    });
                    if (this.recentTrades.length > 40) this.recentTrades.pop();

                    if (maker.remainingQty <= 0) {
                        level.orders.shift();
                        this.orderIndex.delete(maker.id);
                    }
                }
                if (level.totalQty <= 0) this.bids.delete(bidPrice);
                if (remaining <= 0) break;
            }
        }

        if (remaining > 0 && type === 'LIMIT') {
            const order = { id, side, price, remainingQty: remaining };
            this.orderIndex.set(id, order);
            const targetMap = side === 'BUY' ? this.bids : this.asks;
            if (!targetMap.has(price)) {
                targetMap.set(price, { totalQty: 0, orders: [] });
            }
            const lvl = targetMap.get(price);
            lvl.orders.push(order);
            lvl.totalQty += remaining;
        }
        return { success: true };
    }

    getSnapshot(maxDepth = 10) {
        const sortedBids = Array.from(this.bids.keys()).sort((a, b) => b - a).slice(0, maxDepth);
        const sortedAsks = Array.from(this.asks.keys()).sort((a, b) => a - b).slice(0, maxDepth);
        const bestBid = sortedBids.length > 0 ? sortedBids[0] : 0;
        const bestAsk = sortedAsks.length > 0 ? sortedAsks[0] : 0;
        const spread = (bestBid && bestAsk && bestAsk >= bestBid) ? (bestAsk - bestBid) : 0;

        return {
            best_bid: bestBid,
            best_ask: bestAsk,
            spread: spread,
            bids: sortedBids.map(p => ({ price: p, qty: this.bids.get(p).totalQty, orders: 1 })),
            asks: sortedAsks.map(p => ({ price: p, qty: this.asks.get(p).totalQty, orders: 1 }))
        };
    }
}

const engine = new ClientOrderBook('NIFTY50');

// View Mode Switching (Tactile vs Terminal)
const btnViewTactile = document.getElementById('btn-view-tactile');
const btnViewTerminal = document.getElementById('btn-view-terminal');
const viewTactileConsole = document.getElementById('view-tactile-console');
const viewTerminalDesk = document.getElementById('view-terminal-desk');

btnViewTactile.addEventListener('click', () => {
    btnViewTactile.classList.add('active');
    btnViewTerminal.classList.remove('active');
    viewTactileConsole.style.display = 'grid';
    viewTerminalDesk.style.display = 'none';
});

btnViewTerminal.addEventListener('click', () => {
    btnViewTerminal.classList.add('active');
    btnViewTactile.classList.remove('active');
    viewTerminalDesk.style.display = 'block';
    viewTactileConsole.style.display = 'none';
    resizeCanvas();
    fetchSnapshot();
});

// Interactive Chamber Clicking (Sets Active Chamber)
const chambers = document.querySelectorAll('.chamber-cell');
chambers.forEach((ch, idx) => {
    ch.addEventListener('click', () => {
        playClickSound();
        chambers.forEach(c => {
            c.classList.remove('active-chamber');
            const fan = c.querySelector('.tactile-fan-propeller');
            if (fan) {
                fan.className = 'tactile-fan-propeller idle-fan';
            }
            const cross = c.querySelector('.tactile-cross-icon');
            if (cross) cross.className = 'tactile-cross-icon idle-cross';
            const well = c.querySelector('.chamber-bottom-well');
            if (well) well.classList.remove('active-well');
            const pill = c.querySelector('.well-glow-slot');
            if (pill) pill.classList.remove('glow-pill');
            const arr = c.querySelector('.active-down-arrow');
            if (arr) arr.remove();
            const rpmTxt = c.querySelector('.fan-rpm-val');
            if (rpmTxt) rpmTxt.classList.remove('glow-txt');
        });

        ch.classList.add('active-chamber');
        const fan = ch.querySelector('.tactile-fan-propeller');
        if (fan) {
            fan.className = 'tactile-fan-propeller active-fan spin-animation';
        }
        const cross = ch.querySelector('.tactile-cross-icon');
        if (cross) {
            cross.className = 'tactile-cross-icon active-cross glow-cross';
            const arrow = document.createElement('div');
            arrow.className = 'active-down-arrow';
            arrow.textContent = '↓';
            ch.querySelector('.chamber-lower-stage').appendChild(arrow);
        }
        const well = ch.querySelector('.chamber-bottom-well');
        if (well) well.classList.add('active-well');
        const pill = ch.querySelector('.well-glow-slot');
        if (pill) pill.classList.add('glow-pill');
        const rpmTxt = ch.querySelector('.fan-rpm-val');
        if (rpmTxt) rpmTxt.classList.add('glow-txt');

        document.getElementById('pod-throughput-val').textContent = (170 + idx * 12).toString();
        rotateDialKnob();
    });
});

// Rotary Knob Rotation
let dialDeg = 0;
const dialKnob = document.getElementById('dial-knob');
function rotateDialKnob() {
    dialDeg = (dialDeg + 45) % 360;
    dialKnob.style.transform = `rotate(${dialDeg}deg)`;
}
dialKnob.addEventListener('click', () => {
    playClickSound();
    rotateDialKnob();
});

// Audio Toggle
const btnToggleAudio = document.getElementById('btn-toggle-audio');
btnToggleAudio.addEventListener('click', () => {
    isAudioEnabled = !isAudioEnabled;
    btnToggleAudio.textContent = isAudioEnabled ? 'AUDIO: ON' : 'AUDIO: MUTED';
});

// HFT Burst Simulation
document.getElementById('btn-burst-trigger').addEventListener('click', () => runBurst(1000));
function runBurst(count) {
    playClickSound();
    rotateDialKnob();
    for (let i = 0; i < count; i++) {
        const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
        const offset = (Math.floor(Math.random() * 16) - 8) * currentTickSize;
        const price = Math.round((195.00 + offset) * 100);
        const qty = Math.floor(Math.random() * 150) + 10;
        const type = Math.random() > 0.88 ? 'MARKET' : 'LIMIT';
        engine.addOrder(side, type, price, qty);
    }
    updateChamberMetrics();
    fetchSnapshot();
}

// Auto Simulator
const btnToggleAuto = document.getElementById('btn-toggle-auto');
btnToggleAuto.addEventListener('click', () => {
    isAutoMMRunning = !isAutoMMRunning;
    if (isAutoMMRunning) {
        btnToggleAuto.textContent = 'STOP SIMULATOR';
        btnToggleAuto.style.color = '#ef4444';
        btnToggleAuto.style.borderColor = '#ef4444';
        autoMMInterval = setInterval(() => runBurst(20), 180);
    } else {
        btnToggleAuto.textContent = 'AUTO SIMULATOR';
        btnToggleAuto.style.color = 'var(--text-dim)';
        btnToggleAuto.style.borderColor = 'var(--chassis-border)';
        clearInterval(autoMMInterval);
    }
});

function updateChamberMetrics() {
    document.getElementById('ch-metric-1').textContent = (180 + Math.random() * 10).toFixed(1);
    document.getElementById('ch-metric-2').textContent = (60 + Math.random() * 8).toFixed(1);
    document.getElementById('ch-metric-3').textContent = (95 + Math.random() * 10).toFixed(1);
    document.getElementById('ch-metric-4').textContent = (4 + Math.random() * 3).toFixed(1);
    document.getElementById('ch-metric-5').textContent = (260 + Math.random() * 15).toFixed(1);
    document.getElementById('footer-trades-count').textContent = engine.executedTrades.toLocaleString();
}

// Canvas & Order Book Rendering for Terminal View
const canvas = document.getElementById('main-trading-canvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
    if (canvas.parentElement) {
        canvas.width = canvas.parentElement.clientWidth;
        canvas.height = canvas.parentElement.clientHeight;
    }
}
window.addEventListener('resize', resizeCanvas);

function fetchSnapshot() {
    const data = engine.getSnapshot(10);
    renderOrderBook(data);
    drawDepthChart(data);
    renderTrades(engine.recentTrades);
}

function renderOrderBook(data) {
    const asksStream = document.getElementById('asks-stream');
    const bidsStream = document.getElementById('bids-stream');
    const midPriceDisplay = document.getElementById('mid-price-display');
    const spreadAmount = document.getElementById('spread-amount');

    const bestBid = data.best_bid ? (data.best_bid / 100).toFixed(2) : '--';
    const bestAsk = data.best_ask ? (data.best_ask / 100).toFixed(2) : '--';
    const spread = data.spread ? (data.spread / 100).toFixed(2) : '0.00';
    const mid = (data.best_bid && data.best_ask) ? ((data.best_bid + data.best_ask) / 200).toFixed(2) : '19,500.00';

    midPriceDisplay.textContent = `$${mid}`;
    spreadAmount.textContent = `$${spread}`;

    let maxCumulative = 0;
    data.bids.forEach(b => { maxCumulative += b.qty; });
    data.asks.forEach(a => { maxCumulative += a.qty; });
    maxCumulative = Math.max(maxCumulative, 1);

    let askRows = '';
    let runAsk = 0;
    [...data.asks].reverse().forEach(a => {
        runAsk += a.qty;
        const pct = (runAsk / maxCumulative) * 100;
        askRows += `
            <div class="ob-line-row">
                <div class="ob-depth-bar" style="width: ${pct}%"></div>
                <span class="price-num">$${(a.price / 100).toFixed(2)}</span>
                <span class="col-qty">${a.qty}</span>
                <span class="col-orders" style="color:var(--text-dim)">1</span>
                <span class="col-total" style="color:var(--text-dim)">${runAsk}</span>
            </div>
        `;
    });
    asksStream.innerHTML = askRows;

    let bidRows = '';
    let runBid = 0;
    data.bids.forEach(b => {
        runBid += b.qty;
        const pct = (runBid / maxCumulative) * 100;
        bidRows += `
            <div class="ob-line-row">
                <div class="ob-depth-bar" style="width: ${pct}%"></div>
                <span class="price-num">$${(b.price / 100).toFixed(2)}</span>
                <span class="col-qty">${b.qty}</span>
                <span class="col-orders" style="color:var(--text-dim)">1</span>
                <span class="col-total" style="color:var(--text-dim)">${runBid}</span>
            </div>
        `;
    });
    bidsStream.innerHTML = bidRows;
}

function renderTrades(trades) {
    const body = document.getElementById('trades-list-body');
    let html = '';
    trades.slice(0, 15).forEach(t => {
        const timeStr = new Date(Number(t.ts / 1000000n)).toLocaleTimeString();
        html += `
            <div class="trade-row-item ${t.side === 'BUY' ? 'buy-fill' : 'sell-fill'}">
                <span style="color:var(--text-dim)">${timeStr}</span>
                <span class="p-cell">$${(t.price / 100).toFixed(2)}</span>
                <span class="col-right">${t.qty}</span>
                <span class="col-right" style="color:var(--text-dim)">#${t.maker} / #${t.taker}</span>
            </div>
        `;
    });
    body.innerHTML = html;
}

function drawDepthChart(data) {
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    let bidCum = 0;
    const bidPoints = data.bids.map(b => { bidCum += b.qty; return { price: b.price / 100, cum: bidCum }; });
    let askCum = 0;
    const askPoints = data.asks.map(a => { askCum += a.qty; return { price: a.price / 100, cum: askCum }; });
    const maxCum = Math.max(bidCum, askCum, 1);
    const midX = width / 2;

    // Bids
    ctx.beginPath();
    ctx.moveTo(midX, height);
    for (let i = 0; i < bidPoints.length; i++) {
        const x = midX - ((i + 1) / Math.max(bidPoints.length, 1)) * (width / 2);
        const y = height - (bidPoints[i].cum / maxCum) * (height - 20);
        ctx.lineTo(x, y);
    }
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 245, 155, 0.15)';
    ctx.fill();
    ctx.strokeStyle = '#00f59b';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Asks
    ctx.beginPath();
    ctx.moveTo(midX, height);
    for (let i = 0; i < askPoints.length; i++) {
        const x = midX + ((i + 1) / Math.max(askPoints.length, 1)) * (width / 2);
        const y = height - (askPoints[i].cum / maxCum) * (height - 20);
        ctx.lineTo(x, y);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
    ctx.fill();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1.5;
    ctx.stroke();
}

// Side selection
const btnSideBuy = document.getElementById('btn-side-buy');
const btnSideSell = document.getElementById('btn-side-sell');
btnSideBuy.addEventListener('click', () => {
    currentSide = 'BUY';
    btnSideBuy.className = 'side-action-btn buy-active';
    btnSideSell.className = 'side-action-btn';
});
btnSideSell.addEventListener('click', () => {
    currentSide = 'SELL';
    btnSideSell.className = 'side-action-btn sell-active';
    btnSideBuy.className = 'side-action-btn';
});

// Order Submit
document.getElementById('order-form').addEventListener('submit', (e) => {
    e.preventDefault();
    playClickSound();
    const type = document.getElementById('order-type').value;
    const price = Math.round(parseFloat(document.getElementById('order-price').value) * 100);
    const qty = parseInt(document.getElementById('order-qty').value, 10);
    engine.addOrder(currentSide, type, price, qty);
    updateChamberMetrics();
    fetchSnapshot();
});

// Initial tick
updateChamberMetrics();
fetchSnapshot();
