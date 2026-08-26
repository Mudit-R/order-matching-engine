package com.engine.core;

import com.engine.model.*;
import com.engine.ringbuffer.LockFreeRingBuffer;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

public class MatchingEngine {
    public static class Command {
        public enum Action { NEW, CANCEL }
        public Action action;
        public long id;
        public String symbol;
        public Side side;
        public OrderType type;
        public long price;
        public int quantity;
        public long timestampNs;

        public Command(Action action, long id, String symbol, Side side, OrderType type, long price, int quantity) {
            this.action = action;
            this.id = id;
            this.symbol = symbol;
            this.side = side;
            this.type = type;
            this.price = price;
            this.quantity = quantity;
            this.timestampNs = System.nanoTime();
        }
    }

    private final Map<String, LimitOrderBook> books = new ConcurrentHashMap<>();
    private final LockFreeRingBuffer<Command> ringBuffer = new LockFreeRingBuffer<>(1048576);
    private final AtomicBoolean running = new AtomicBoolean(false);
    private Thread workerThread;
    private final Consumer<Trade> tradeListener;

    public final AtomicLong processedOrders = new AtomicLong(0);
    public final AtomicLong executedTrades = new AtomicLong(0);

    public MatchingEngine(Consumer<Trade> tradeListener) {
        this.tradeListener = tradeListener;
    }

    public void registerSymbol(String symbol) {
        books.put(symbol, new LimitOrderBook(symbol, t -> {
            executedTrades.incrementAndGet();
            if (tradeListener != null) {
                tradeListener.accept(t);
            }
        }));
    }

    public LimitOrderBook getBook(String symbol) {
        return books.get(symbol);
    }

    public boolean submitCommand(Command cmd) {
        return ringBuffer.push(cmd);
    }

    public void start() {
        if (running.compareAndSet(false, true)) {
            workerThread = new Thread(this::runEventLoop, "Matching-Engine-Worker");
            workerThread.start();
        }
    }

    public void stop() {
        if (running.compareAndSet(true, false)) {
            try {
                if (workerThread != null) workerThread.join();
            } catch (InterruptedException ignored) {}
        }
    }

    private void runEventLoop() {
        while (running.get() || !ringBuffer.isEmpty()) {
            Command cmd = ringBuffer.pop();
            if (cmd != null) {
                processedOrders.incrementAndGet();
                LimitOrderBook book = books.get(cmd.symbol);
                if (book != null) {
                    if (cmd.action == Command.Action.NEW) {
                        book.addOrder(cmd.id, cmd.side, cmd.type, cmd.price, cmd.quantity, cmd.timestampNs);
                    } else if (cmd.action == Command.Action.CANCEL) {
                        book.cancelOrder(cmd.id);
                    }
                }
            } else {
                Thread.onSpinWait();
            }
        }
    }
}
