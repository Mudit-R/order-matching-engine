#pragma once

#include <map>
#include <unordered_map>
#include <vector>
#include <string>
#include <functional>
#include "types.hpp"
#include "memory_pool.hpp"

namespace Engine {

/**
 * @brief PriceLevel represents an aggregation of all active orders at a specific price.
 * Orders are chained in an intrusive doubly-linked list to guarantee strict FIFO (time-priority).
 */
struct PriceLevel {
    Price price{0};
    Quantity total_quantity{0};
    uint32_t order_count{0};
    Order* head{nullptr};
    Order* tail{nullptr};

    void append(Order* order) noexcept {
        order->prev = tail;
        order->next = nullptr;
        if (tail != nullptr) {
            tail->next = order;
        } else {
            head = order;
        }
        tail = order;
        total_quantity += order->remaining_qty;
        ++order_count;
    }

    void remove(Order* order) noexcept {
        if (order->prev != nullptr) {
            order->prev->next = order->next;
        } else {
            head = order->next;
        }

        if (order->next != nullptr) {
            order->next->prev = order->prev;
        } else {
            tail = order->prev;
        }

        total_quantity -= order->remaining_qty;
        --order_count;
        order->prev = nullptr;
        order->next = nullptr;
    }
};

/**
 * @brief Institutional-Grade Continuous Limit Order Book.
 * Supports Price-Time Priority, GTC, IOC, FOK, Market Orders, Order Cancellations,
 * and real-time Level 2 Market Depth calculation.
 */
class LimitOrderBook {
public:
    using TradeCallback = std::function<void(const Trade&)>;

    explicit LimitOrderBook(std::string symbol, TradeCallback on_trade = nullptr);
    ~LimitOrderBook();

    // Order operations
    bool addOrder(OrderId id, Side side, OrderType type, Price price, Quantity qty, Timestamp ts = 0);
    bool cancelOrder(OrderId id);
    bool modifyOrder(OrderId id, Quantity new_qty);

    // Queries
    [[nodiscard]] const std::string& getSymbol() const noexcept { return symbol_; }
    [[nodiscard]] Price getBestBid() const noexcept;
    [[nodiscard]] Price getBestAsk() const noexcept;
    [[nodiscard]] Price getSpread() const noexcept;
    [[nodiscard]] Price getMidPrice() const noexcept;
    [[nodiscard]] size_t getActiveOrderCount() const noexcept { return order_index_.size(); }

    // Level-2 Market Depth Snapshot (Aggregated price levels)
    [[nodiscard]] Level2Snapshot getLevel2Snapshot(size_t max_depth = 10) const;

    void setTradeCallback(TradeCallback callback) { on_trade_ = std::move(callback); }

private:
    void matchLimitOrder(Order* taker);
    void matchMarketOrder(Order* taker);
    bool canFillFOK(Side side, Price price, Quantity qty) const;
    void executeTrade(Order* maker, Order* taker, Price price, Quantity match_qty);
    void removeFilledOrder(Order* order, PriceLevel& level);

    std::string symbol_;
    TradeCallback on_trade_;

    // Bids sorted in descending order (highest price first)
    std::map<Price, PriceLevel, std::greater<Price>> bids_;
    
    // Asks sorted in ascending order (lowest price first)
    std::map<Price, PriceLevel, std::less<Price>> asks_;

    // Fast O(1) Hash Map for Order Lookup by ID
    std::unordered_map<OrderId, Order*> order_index_;

    // Zero-allocation memory pool for Order structures
    ObjectPool<Order> order_pool_;
};

} // namespace Engine
