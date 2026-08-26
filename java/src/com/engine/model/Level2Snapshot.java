package com.engine.model;

import java.util.List;

public class Level2Snapshot {
    public static class LevelEntry {
        public final long price;
        public final int totalQuantity;
        public final int orderCount;

        public LevelEntry(long price, int totalQuantity, int orderCount) {
            this.price = price;
            this.totalQuantity = totalQuantity;
            this.orderCount = orderCount;
        }
    }

    public final String symbol;
    public final long timestampNs;
    public final List<LevelEntry> bids;
    public final List<LevelEntry> asks;

    public Level2Snapshot(String symbol, long timestampNs, List<LevelEntry> bids, List<LevelEntry> asks) {
        this.symbol = symbol;
        this.timestampNs = timestampNs;
        this.bids = bids;
        this.asks = asks;
    }
}
