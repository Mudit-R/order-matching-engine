#pragma once

#include <string>
#include <unordered_map>
#include <mutex>
#include <chrono>
#include <cstdint>
#include "types.hpp"

namespace Engine {

/**
 * @brief Institutional Idempotency Guard for Exchange Order Ingestion.
 * 
 * Prevents double-execution of client order requests during network retries,
 * gateway reconnection storms, or client timeout race conditions.
 * Guaranteed zero duplicate matching within the sliding TTL window.
 */
class IdempotencyGuard {
public:
    enum class Status : uint8_t {
        NEW_REQUEST = 0,    // First time seeing this idempotency key. Reserved for execution.
        DUPLICATE_CACHED = 1, // Key has already been processed. Return cached execution report.
        IN_FLIGHT = 2       // Request is currently executing concurrently. Reject concurrent duplicate.
    };

    struct CachedRecord {
        OrderId order_id{0};
        Quantity filled_qty{0};
        Price avg_price{0};
        bool is_active{false};
        bool in_flight{true};
        uint64_t timestamp_ns{0};
    };

    explicit IdempotencyGuard(uint64_t ttl_ns = 60'000'000'000ULL) // Default 60-second TTL
        : ttl_ns_(ttl_ns) {}

    /**
     * @brief Atomically checks if key was previously seen or is currently in flight.
     * If new, reserves the slot in IN_FLIGHT state.
     */
    Status check_or_reserve(const std::string& idempotency_key, CachedRecord& out_cached) {
        if (idempotency_key.empty()) {
            return Status::NEW_REQUEST;
        }

        const uint64_t now = get_current_time_ns();
        std::lock_guard<std::mutex> lock(mutex_);

        auto it = records_.find(idempotency_key);
        if (it != records_.end()) {
            // Check if expired
            if (now - it->second.timestamp_ns > ttl_ns_) {
                // Key expired, recycle slot as new
                it->second.in_flight = true;
                it->second.timestamp_ns = now;
                return Status::NEW_REQUEST;
            }

            if (it->second.in_flight) {
                return Status::IN_FLIGHT;
            }

            out_cached = it->second;
            return Status::DUPLICATE_CACHED;
        }

        // New request: insert into in-flight state
        records_[idempotency_key] = CachedRecord{
            .order_id = 0,
            .filled_qty = 0,
            .avg_price = 0,
            .is_active = true,
            .in_flight = true,
            .timestamp_ns = now
        };

        return Status::NEW_REQUEST;
    }

    /**
     * @brief Commits the final execution report to the idempotency cache.
     */
    void commit(const std::string& idempotency_key, OrderId order_id, Quantity filled_qty, Price avg_price) {
        if (idempotency_key.empty()) return;

        const uint64_t now = get_current_time_ns();
        std::lock_guard<std::mutex> lock(mutex_);

        auto it = records_.find(idempotency_key);
        if (it != records_.end()) {
            it->second.order_id = order_id;
            it->second.filled_qty = filled_qty;
            it->second.avg_price = avg_price;
            it->second.in_flight = false;
            it->second.timestamp_ns = now;
        }
    }

    /**
     * @brief Size of the active cache.
     */
    size_t size() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return records_.size();
    }

    /**
     * @brief Clear all cached idempotency records.
     */
    void clear() {
        std::lock_guard<std::mutex> lock(mutex_);
        records_.clear();
    }

private:
    static uint64_t get_current_time_ns() {
        return static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now().time_since_epoch()
            ).count()
        );
    }

    uint64_t ttl_ns_;
    mutable std::mutex mutex_;
    std::unordered_map<std::string, CachedRecord> records_;
};

} // namespace Engine
