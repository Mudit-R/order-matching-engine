package com.engine.model;

public class Trade {
    public final long makerOrderId;
    public final long takerOrderId;
    public final long price;
    public final int quantity;
    public final Side takerSide;
    public final long timestampNs;

    public Trade(long makerOrderId, long takerOrderId, long price, int quantity, Side takerSide, long timestampNs) {
        this.makerOrderId = makerOrderId;
        this.takerOrderId = takerOrderId;
        this.price = price;
        this.quantity = quantity;
        this.takerSide = takerSide;
        this.timestampNs = timestampNs;
    }

    @Override
    public String toString() {
        return String.format("Trade[Maker=%d, Taker=%d, Price=%.2f, Qty=%d, Side=%s]",
                makerOrderId, takerOrderId, price / 100.0, quantity, takerSide);
    }
}
