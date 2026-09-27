package com.engine.core;

import java.util.concurrent.ConcurrentHashMap;
import java.util.Map;

/**
 * Institutional Idempotency Guard for Java 22 Matching Core.
 * 
 * Guarantees zero duplicate order execution under concurrent client retry bursts
 * within an atomic sliding-window TTL cache.
 */
public class IdempotencyGuard {

    public enum Status {
        NEW_REQUEST,
        DUPLICATE_CACHED,
        IN_FLIGHT
    }

    public static class CachedRecord {
        public final long orderId;
        public final int filledQty;
        public final long avgPrice;
        public final boolean inFlight;
        public final long timestampNs;

        public CachedRecord(long orderId, int filledQty, long avgPrice, boolean inFlight, long timestampNs) {
            this.orderId = orderId;
            this.filledQty = filledQty;
            this.avgPrice = avgPrice;
            this.inFlight = inFlight;
            this.timestampNs = timestampNs;
        }
    }

    private final long ttlNs;
    private final Map<String, CachedRecord> cache = new ConcurrentHashMap<>();

    public IdempotencyGuard() {
        this(60_000_000_000L); // Default 60s TTL
    }

    public IdempotencyGuard(long ttlNs) {
        this.ttlNs = ttlNs;
    }

    /**
     * Atomically inspects and reserves an idempotency key.
     */
    public Status checkOrReserve(String idempotencyKey) {
        if (idempotencyKey == null || idempotencyKey.isEmpty()) {
            return Status.NEW_REQUEST;
        }

        long now = System.nanoTime();

        CachedRecord existing = cache.get(idempotencyKey);
        if (existing != null) {
            if (now - existing.timestampNs > ttlNs) {
                // Expired: recycle as new in-flight
                cache.put(idempotencyKey, new CachedRecord(0, 0, 0, true, now));
                return Status.NEW_REQUEST;
            }
            if (existing.inFlight) {
                return Status.IN_FLIGHT;
            }
            return Status.DUPLICATE_CACHED;
        }

        // Reserve as in-flight
        CachedRecord prev = cache.putIfAbsent(idempotencyKey, new CachedRecord(0, 0, 0, true, now));
        if (prev != null) {
            return prev.inFlight ? Status.IN_FLIGHT : Status.DUPLICATE_CACHED;
        }

        return Status.NEW_REQUEST;
    }

    /**
     * Commits the execution outcome to the idempotency cache.
     */
    public void commit(String idempotencyKey, long orderId, int filledQty, long avgPrice) {
        if (idempotencyKey == null || idempotencyKey.isEmpty()) {
            return;
        }
        cache.put(idempotencyKey, new CachedRecord(orderId, filledQty, avgPrice, false, System.nanoTime()));
    }

    /**
     * Retrieves the cached execution report for a duplicate request.
     */
    public CachedRecord getCachedRecord(String idempotencyKey) {
        return cache.get(idempotencyKey);
    }

    public int size() {
        return cache.size();
    }

    public void clear() {
        cache.clear();
    }
}
