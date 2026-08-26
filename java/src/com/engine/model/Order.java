package com.engine.model;

/**
 * High-performance Order object with intrusive doubly-linked list pointers
 * for O(1) insertion, deletion, and FIFO queue iteration at price levels.
 */
public class Order {
    public long id;
    public long price; // Fixed-point (e.g. 15025 = $150.25)
    public int initialQty;
    public int remainingQty;
    public Side side;
    public OrderType type;
    public long timestampNs;

    // Intrusive pointers
    public Order prev;
    public Order next;

    public Order() {}

    public Order(long id, long price, int qty, Side side, OrderType type, long timestampNs) {
        this.id = id;
        this.price = price;
        this.initialQty = qty;
        this.remainingQty = qty;
        this.side = side;
        this.type = type;
        this.timestampNs = timestampNs;
        this.prev = null;
        this.next = null;
    }

    public boolean isFilled() {
        return remainingQty <= 0;
    }
}
