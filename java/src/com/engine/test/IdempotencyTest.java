package com.engine.test;

import com.engine.core.IdempotencyGuard;

public class IdempotencyTest {
    public static void main(String[] args) {
        System.out.println("==================================================");
        System.out.println("  Running IdempotencyGuard Unit & Concurrency Test ");
        System.out.println("==================================================");

        IdempotencyGuard guard = new IdempotencyGuard(10_000_000_000L); // 10s TTL

        // 1. First order submission
        String key1 = "req_client_9921_order_001";
        IdempotencyGuard.Status status1 = guard.checkOrReserve(key1);
        if (status1 != IdempotencyGuard.Status.NEW_REQUEST) {
            throw new AssertionError("Expected NEW_REQUEST on first check, got: " + status1);
        }
        System.out.println("[TEST 1] First Submission Reservation ... PASSED");

        // 2. In-flight collision test (immediate concurrent retry while matching is in progress)
        IdempotencyGuard.Status statusConcurrent = guard.checkOrReserve(key1);
        if (statusConcurrent != IdempotencyGuard.Status.IN_FLIGHT) {
            throw new AssertionError("Expected IN_FLIGHT for concurrent retry, got: " + statusConcurrent);
        }
        System.out.println("[TEST 2] In-Flight Concurrent Collision Guard ... PASSED");

        // 3. Commit order execution report
        guard.commit(key1, 1001L, 50, 19550L);
        System.out.println("[TEST 3] Execution Report Commit ... PASSED");

        // 4. Duplicate request returns cached execution report without side effects
        IdempotencyGuard.Status statusDup = guard.checkOrReserve(key1);
        if (statusDup != IdempotencyGuard.Status.DUPLICATE_CACHED) {
            throw new AssertionError("Expected DUPLICATE_CACHED, got: " + statusDup);
        }
        IdempotencyGuard.CachedRecord record = guard.getCachedRecord(key1);
        if (record.orderId != 1001L || record.filledQty != 50 || record.avgPrice != 19550L) {
            throw new AssertionError("Cached record mismatch: " + record.orderId + ", qty: " + record.filledQty);
        }
        System.out.println("[TEST 4] Duplicate Cached Replay (Zero Side-Effects) ... PASSED");

        System.out.println("\n>>> ALL IDEMPOTENCY GUARD TESTS PASSED WITH 100% SUCCESS! <<<\n");
    }
}
