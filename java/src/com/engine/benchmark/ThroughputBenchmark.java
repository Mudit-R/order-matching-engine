package com.engine.benchmark;

import com.engine.core.LimitOrderBook;
import com.engine.model.OrderType;
import com.engine.model.Side;

import java.util.Arrays;
import java.util.Random;

public class ThroughputBenchmark {
    public static void main(String[] args) {
        int totalOrders = 1_000_000;
        System.out.println("==========================================================");
        System.out.println(" Java 22 High-Throughput Matching Engine Latency Benchmark");
        System.out.println(" Orders to Process: " + totalOrders);
        System.out.println("==========================================================");

        LimitOrderBook book = new LimitOrderBook("NIFTY_FUT", null);
        long[] latenciesNs = new long[totalOrders];

        Random rng = new Random(42);

        // Warmup JIT compiler
        System.out.println("Warming up JVM HotSpot C2 Compiler with 100k iterations...");
        LimitOrderBook warmupBook = new LimitOrderBook("WARMUP", null);
        for (int i = 1; i <= 100_000; i++) {
            Side side = rng.nextBoolean() ? Side.BUY : Side.SELL;
            long price = 19800 + rng.nextInt(400);
            int qty = 10 + rng.nextInt(490);
            warmupBook.addOrder(i, side, OrderType.LIMIT, price, qty, 0);
        }

        System.out.println("Starting 1,000,000 Order Matching Benchmark...");
        long startTotalNs = System.nanoTime();

        for (int i = 1; i <= totalOrders; i++) {
            Side side = rng.nextBoolean() ? Side.BUY : Side.SELL;
            long price = 19800 + rng.nextInt(400);
            int qty = 10 + rng.nextInt(490);
            OrderType type = (rng.nextInt(10) == 0) ? OrderType.MARKET : OrderType.LIMIT;

            long t0 = System.nanoTime();
            book.addOrder(i, side, type, price, qty, t0);
            long t1 = System.nanoTime();

            latenciesNs[i - 1] = (t1 - t0);
        }

        long endTotalNs = System.nanoTime();
        double totalTimeSec = (endTotalNs - startTotalNs) / 1_000_000_000.0;

        Arrays.sort(latenciesNs);

        long sumNs = 0;
        for (long l : latenciesNs) sumNs += l;
        double avgUs = (sumNs / (double) totalOrders) / 1000.0;
        double p50Us = latenciesNs[(int) (totalOrders * 0.50)] / 1000.0;
        double p90Us = latenciesNs[(int) (totalOrders * 0.90)] / 1000.0;
        double p99Us = latenciesNs[(int) (totalOrders * 0.99)] / 1000.0;
        double p999Us = latenciesNs[(int) (totalOrders * 0.999)] / 1000.0;
        double throughput = totalOrders / totalTimeSec;

        System.out.println("\n---------------- Benchmark Results ----------------");
        System.out.printf("Throughput:       %,d orders/second\n", (long) throughput);
        System.out.printf("Average Latency:  %.3f µs\n", avgUs);
        System.out.printf("P50 Latency:      %.3f µs\n", p50Us);
        System.out.printf("P90 Latency:      %.3f µs\n", p90Us);
        System.out.printf("P99 Latency:      %.3f µs\n", p99Us);
        System.out.printf("P99.9 Latency:    %.3f µs\n", p999Us);
        System.out.printf("Min Latency:      %.3f µs\n", latenciesNs[0] / 1000.0);
        System.out.printf("Max Latency:      %.3f µs\n", latenciesNs[totalOrders - 1] / 1000.0);
        System.out.println("---------------------------------------------------");
    }
}
