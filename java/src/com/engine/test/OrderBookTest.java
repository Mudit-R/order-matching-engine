package com.engine.test;

import com.engine.core.LimitOrderBook;
import com.engine.model.OrderType;
import com.engine.model.Side;
import com.engine.model.Trade;

import java.util.ArrayList;
import java.util.List;

public class OrderBookTest {
    public static void main(String[] args) {
        System.out.println("==================================================");
        System.out.println("  Running Full Matching Engine Unit Test Suite    ");
        System.out.println("==================================================");

        testBasicLimitMatching();
        testPriceTimePriorityFIFO();
        testOrderCancellation();
        testIOCAndFOK();

        System.out.println("\n>>> ALL 4 TEST SUITES PASSED WITH 100% SUCCESS! <<<\n");
    }

    private static void testBasicLimitMatching() {
        System.out.print("[TEST] Basic Limit Order Matching & Partial Fills ... ");
        List<Trade> trades = new ArrayList<>();
        LimitOrderBook book = new LimitOrderBook("NIFTY", trades::add);

        // Add Sell Limit: 100 @ 19500 ($195.00)
        book.addOrder(1, Side.SELL, OrderType.LIMIT, 19500, 100, 0);
        if (book.getActiveOrderCount() != 1 || book.getBestAsk() != 19500) throw new AssertionError();

        // Taker Buy Limit: 40 @ 19500 -> Partial Fill
        book.addOrder(2, Side.BUY, OrderType.LIMIT, 19500, 40, 0);
        if (trades.size() != 1 || trades.get(0).quantity != 40 || trades.get(0).price != 19500) throw new AssertionError();
        if (book.getActiveOrderCount() != 1) throw new AssertionError("Maker order should have 60 shares remaining");

        // Taker Buy Market: 60 -> Complete Fill
        book.addOrder(3, Side.BUY, OrderType.MARKET, 0, 60, 0);
        if (trades.size() != 2 || trades.get(1).quantity != 60) throw new AssertionError();
        if (book.getActiveOrderCount() != 0 || book.getBestAsk() != 0) throw new AssertionError();

        System.out.println("PASSED");
    }

    private static void testPriceTimePriorityFIFO() {
        System.out.print("[TEST] Strict Price-Time FIFO Execution Priority ... ");
        List<Trade> trades = new ArrayList<>();
        LimitOrderBook book = new LimitOrderBook("RELIANCE", trades::add);

        // Two sell orders at the exact same price
        book.addOrder(10, Side.SELL, OrderType.LIMIT, 25000, 50, 0); // Arrived 1st
        book.addOrder(20, Side.SELL, OrderType.LIMIT, 25000, 50, 0); // Arrived 2nd

        // Incoming buy order matches 60 shares
        book.addOrder(30, Side.BUY, OrderType.LIMIT, 25000, 60, 0);

        if (trades.size() != 2) throw new AssertionError("Should produce 2 trade events");
        if (trades.get(0).makerOrderId != 10 || trades.get(0).quantity != 50) throw new AssertionError("Order 10 must be filled 1st");
        if (trades.get(1).makerOrderId != 20 || trades.get(1).quantity != 10) throw new AssertionError("Order 20 must be filled 2nd");
        if (book.getActiveOrderCount() != 1) throw new AssertionError();

        System.out.println("PASSED");
    }

    private static void testOrderCancellation() {
        System.out.print("[TEST] O(1) Order Cancellation & Level Pruning ... ");
        LimitOrderBook book = new LimitOrderBook("TCS", null);

        book.addOrder(1, Side.BUY, OrderType.LIMIT, 35000, 100, 0);
        if (book.getActiveOrderCount() != 1 || book.getBestBid() != 35000) throw new AssertionError();

        if (!book.cancelOrder(1)) throw new AssertionError("Cancel should succeed");
        if (book.getActiveOrderCount() != 0 || book.getBestBid() != 0) throw new AssertionError("Book should be empty");

        // Cancelling non-existent order
        if (book.cancelOrder(999)) throw new AssertionError("Cancel non-existent should return false");

        System.out.println("PASSED");
    }

    private static void testIOCAndFOK() {
        System.out.print("[TEST] Immediate-Or-Cancel (IOC) & Fill-Or-Kill (FOK) ... ");
        List<Trade> trades = new ArrayList<>();
        LimitOrderBook book = new LimitOrderBook("INFY", trades::add);

        book.addOrder(1, Side.SELL, OrderType.LIMIT, 18000, 50, 0);

        // FOK for 100 shares -> Must reject since only 50 available
        boolean fokResult = book.addOrder(2, Side.BUY, OrderType.FOK, 18000, 100, 0);
        if (fokResult || !trades.isEmpty() || book.getActiveOrderCount() != 1) throw new AssertionError("FOK must fail");

        // IOC for 100 shares -> Must match 50 and cancel 50
        boolean iocResult = book.addOrder(3, Side.BUY, OrderType.IOC, 18000, 100, 0);
        if (!iocResult || trades.size() != 1 || trades.get(0).quantity != 50) throw new AssertionError("IOC should partially fill");
        if (book.getActiveOrderCount() != 0) throw new AssertionError("IOC remainder must not rest on book");

        System.out.println("PASSED");
    }
}
