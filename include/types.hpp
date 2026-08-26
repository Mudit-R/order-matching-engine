#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <chrono>
#include <sstream>
#include <iomanip>

namespace Engine {

using OrderId = uint64_t;
using Price = uint64_t;     // Stored in fixed-point cents / ticks to prevent floating-point errors (e.g. $150.25 -> 15025)
using Quantity = uint32_t;
using Timestamp = uint64_t; // Nanoseconds since epoch

enum class Side : uint8_t {
    BUY = 0,
    SELL = 1
};

enum class OrderType : uint8_t {
    LIMIT = 0,
    MARKET = 1,
    IOC = 2,  // Immediate-Or-Cancel
    FOK = 3   // Fill-Or-Kill
};

enum class OrderAction : uint8_t {
    NEW = 0,
    CANCEL = 1,
    MODIFY = 2
};

struct alignas(64) Order {
    OrderId id{0};
    Price price{0};
    Quantity initial_qty{0};
    Quantity remaining_qty{0};
    Side side{Side::BUY};
    OrderType type{OrderType::LIMIT};
    Timestamp timestamp{0};
    
    // Intrusive Doubly-Linked List Pointers for O(1) Insertion & Deletion in Price Bucket
    Order* prev{nullptr};
    Order* next{nullptr};

    bool is_filled() const noexcept {
        return remaining_qty == 0;
    }
};

struct Trade {
    OrderId maker_order_id{0};
    OrderId taker_order_id{0};
    Price price{0};
    Quantity quantity{0};
    Side taker_side{Side::BUY};
    Timestamp timestamp{0};
};

struct Level2Entry {
    Price price{0};
    Quantity total_quantity{0};
    uint32_t order_count{0};
};

struct Level2Snapshot {
    std::string symbol;
    Timestamp timestamp{0};
    std::vector<Level2Entry> bids;
    std::vector<Level2Entry> asks;
};

inline Timestamp getCurrentTimestampNs() noexcept {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::high_resolution_clock::now().time_since_epoch()
    ).count();
}

inline std::string formatPrice(Price price) {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(2) << (static_cast<double>(price) / 100.0);
    return ss.str();
}

} // namespace Engine
