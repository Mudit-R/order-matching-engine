package com.engine.core;

import com.engine.model.*;
import java.util.*;
import java.util.function.Consumer;

/**
 * Continuous Double-Auction Limit Order Book in Java.
 * Features O(1) order operations, GTC, IOC, FOK, Market orders, cancellations, and Level 2 snapshots.
 */
public class LimitOrderBook {
    private final String symbol;
    private final Consumer<Trade> onTrade;

    // TreeMap for sorted price levels (Bids descending, Asks ascending)
    private final NavigableMap<Long, PriceLevel> bids = new TreeMap<>(Collections.reverseOrder());
    private final NavigableMap<Long, PriceLevel> asks = new TreeMap<>();

    // O(1) ID lookup index
    private final Map<Long, Order> orderIndex = new HashMap<>(131072);

    public LimitOrderBook(String symbol, Consumer<Trade> onTrade) {
        this.symbol = symbol;
        this.onTrade = onTrade;
    }

    public String getSymbol() {
        return symbol;
    }

    public long getBestBid() {
        return bids.isEmpty() ? 0 : bids.firstKey();
    }

    public long getBestAsk() {
        return asks.isEmpty() ? 0 : asks.firstKey();
    }

    public long getSpread() {
        long bestBid = getBestBid();
        long bestAsk = getBestAsk();
        if (bestBid == 0 || bestAsk == 0 || bestAsk < bestBid) return 0;
        return bestAsk - bestBid;
    }

    public int getActiveOrderCount() {
        return orderIndex.size();
    }

    public boolean canFillFOK(Side side, long price, int targetQty) {
        int cumulative = 0;
        if (side == Side.BUY) {
            for (Map.Entry<Long, PriceLevel> entry : asks.entrySet()) {
                if (entry.getKey() > price) break;
                cumulative += entry.getValue().totalQuantity;
                if (cumulative >= targetQty) return true;
            }
        } else {
            for (Map.Entry<Long, PriceLevel> entry : bids.entrySet()) {
                if (entry.getKey() < price) break;
                cumulative += entry.getValue().totalQuantity;
                if (cumulative >= targetQty) return true;
            }
        }
        return false;
    }

    public boolean addOrder(long id, Side side, OrderType type, long price, int qty, long ts) {
        if (qty <= 0 || orderIndex.containsKey(id)) {
            return false;
        }

        if (ts == 0) {
            ts = System.nanoTime();
        }

        if (type == OrderType.FOK && !canFillFOK(side, price, qty)) {
            return false;
        }

        Order taker = new Order(id, price, qty, side, type, ts);

        if (type == OrderType.MARKET) {
            matchMarketOrder(taker);
            return true;
        }

        matchLimitOrder(taker);

        if (taker.isFilled()) {
            return true;
        }

        if (type == OrderType.IOC || type == OrderType.FOK) {
            return true; // Cancel remainder
        }

        // Rest order on book
        orderIndex.put(id, taker);
        if (side == Side.BUY) {
            PriceLevel level = bids.computeIfAbsent(price, PriceLevel::new);
            level.append(taker);
        } else {
            PriceLevel level = asks.computeIfAbsent(price, PriceLevel::new);
            level.append(taker);
        }

        return true;
    }

    private void matchLimitOrder(Order taker) {
        if (taker.side == Side.BUY) {
            Iterator<Map.Entry<Long, PriceLevel>> it = asks.entrySet().iterator();
            while (it.hasNext() && !taker.isFilled()) {
                Map.Entry<Long, PriceLevel> entry = it.next();
                long askPrice = entry.getKey();
                if (askPrice > taker.price) {
                    break;
                }

                PriceLevel level = entry.getValue();
                Order maker = level.head;

                while (maker != null && !taker.isFilled()) {
                    Order nextMaker = maker.next;
                    int matchQty = Math.min(taker.remainingQty, maker.remainingQty);
                    executeTrade(maker, taker, askPrice, matchQty);

                    if (maker.isFilled()) {
                        orderIndex.remove(maker.id);
                        level.remove(maker);
                    }
                    maker = nextMaker;
                }

                if (level.orderCount == 0) {
                    it.remove();
                }
            }
        } else {
            Iterator<Map.Entry<Long, PriceLevel>> it = bids.entrySet().iterator();
            while (it.hasNext() && !taker.isFilled()) {
                Map.Entry<Long, PriceLevel> entry = it.next();
                long bidPrice = entry.getKey();
                if (bidPrice < taker.price) {
                    break;
                }

                PriceLevel level = entry.getValue();
                Order maker = level.head;

                while (maker != null && !taker.isFilled()) {
                    Order nextMaker = maker.next;
                    int matchQty = Math.min(taker.remainingQty, maker.remainingQty);
                    executeTrade(maker, taker, bidPrice, matchQty);

                    if (maker.isFilled()) {
                        orderIndex.remove(maker.id);
                        level.remove(maker);
                    }
                    maker = nextMaker;
                }

                if (level.orderCount == 0) {
                    it.remove();
                }
            }
        }
    }

    private void matchMarketOrder(Order taker) {
        if (taker.side == Side.BUY) {
            Iterator<Map.Entry<Long, PriceLevel>> it = asks.entrySet().iterator();
            while (it.hasNext() && !taker.isFilled()) {
                Map.Entry<Long, PriceLevel> entry = it.next();
                PriceLevel level = entry.getValue();
                Order maker = level.head;

                while (maker != null && !taker.isFilled()) {
                    Order nextMaker = maker.next;
                    int matchQty = Math.min(taker.remainingQty, maker.remainingQty);
                    executeTrade(maker, taker, entry.getKey(), matchQty);

                    if (maker.isFilled()) {
                        orderIndex.remove(maker.id);
                        level.remove(maker);
                    }
                    maker = nextMaker;
                }

                if (level.orderCount == 0) {
                    it.remove();
                }
            }
        } else {
            Iterator<Map.Entry<Long, PriceLevel>> it = bids.entrySet().iterator();
            while (it.hasNext() && !taker.isFilled()) {
                Map.Entry<Long, PriceLevel> entry = it.next();
                PriceLevel level = entry.getValue();
                Order maker = level.head;

                while (maker != null && !taker.isFilled()) {
                    Order nextMaker = maker.next;
                    int matchQty = Math.min(taker.remainingQty, maker.remainingQty);
                    executeTrade(maker, taker, entry.getKey(), matchQty);

                    if (maker.isFilled()) {
                        orderIndex.remove(maker.id);
                        level.remove(maker);
                    }
                    maker = nextMaker;
                }

                if (level.orderCount == 0) {
                    it.remove();
                }
            }
        }
    }

    private void executeTrade(Order maker, Order taker, long price, int matchQty) {
        maker.remainingQty -= matchQty;
        taker.remainingQty -= matchQty;

        if (onTrade != null) {
            onTrade.accept(new Trade(maker.id, taker.id, price, matchQty, taker.side, System.nanoTime()));
        }
    }

    public boolean cancelOrder(long id) {
        Order order = orderIndex.remove(id);
        if (order == null) return false;

        if (order.side == Side.BUY) {
            PriceLevel level = bids.get(order.price);
            if (level != null) {
                level.remove(order);
                if (level.orderCount == 0) bids.remove(order.price);
            }
        } else {
            PriceLevel level = asks.get(order.price);
            if (level != null) {
                level.remove(order);
                if (level.orderCount == 0) asks.remove(order.price);
            }
        }
        return true;
    }

    public Level2Snapshot getLevel2Snapshot(int maxDepth) {
        List<Level2Snapshot.LevelEntry> bidList = new ArrayList<>(maxDepth);
        int count = 0;
        for (Map.Entry<Long, PriceLevel> entry : bids.entrySet()) {
            if (count++ >= maxDepth) break;
            bidList.add(new Level2Snapshot.LevelEntry(entry.getKey(), entry.getValue().totalQuantity, entry.getValue().orderCount));
        }

        List<Level2Snapshot.LevelEntry> askList = new ArrayList<>(maxDepth);
        count = 0;
        for (Map.Entry<Long, PriceLevel> entry : asks.entrySet()) {
            if (count++ >= maxDepth) break;
            askList.add(new Level2Snapshot.LevelEntry(entry.getKey(), entry.getValue().totalQuantity, entry.getValue().orderCount));
        }

        return new Level2Snapshot(symbol, System.nanoTime(), bidList, askList);
    }
}
