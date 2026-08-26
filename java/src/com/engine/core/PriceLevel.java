package com.engine.core;

import com.engine.model.Order;

/**
 * Doubly-linked FIFO order queue at a specific price point.
 * Guarantees strict Price-Time Priority and O(1) order removal.
 */
public class PriceLevel {
    public final long price;
    public int totalQuantity;
    public int orderCount;
    public Order head;
    public Order tail;

    public PriceLevel(long price) {
        this.price = price;
        this.totalQuantity = 0;
        this.orderCount = 0;
        this.head = null;
        this.tail = null;
    }

    public void append(Order order) {
        order.prev = tail;
        order.next = null;
        if (tail != null) {
            tail.next = order;
        } else {
            head = order;
        }
        tail = order;
        totalQuantity += order.remainingQty;
        orderCount++;
    }

    public void remove(Order order) {
        if (order.prev != null) {
            order.prev.next = order.next;
        } else {
            head = order.next;
        }

        if (order.next != null) {
            order.next.prev = order.prev;
        } else {
            tail = order.prev;
        }

        totalQuantity -= order.remainingQty;
        orderCount--;
        order.prev = null;
        order.next = null;
    }
}
