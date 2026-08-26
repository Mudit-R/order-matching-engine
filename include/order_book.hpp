#pragma once

#include <map>
#include <unordered_map>
#include <vector>
#include <string>
#include <functional>
#include "types.hpp"
#include "memory_pool.hpp"

namespace Engine {

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

class LimitOrderBook {
public:
    using TradeCallback = std::function<void(const Trade&)>;

    explicit LimitOrderBook(std::string symbol, TradeCallback on_trade = nullptr);
    ~LimitOrderBook();

    // Order operations with Iceberg, STP, and Post-Only support
    bool addOrder(OrderId id, ClientId client_id, Side side, OrderType type,
                  Price price, Quantity qty, Quantity display_qty = 0,
                  SelfTradePrevention stp = SelfTradePrevention::NONE, Timestamp ts = 0);
    
    // Convenience overload
    bool addOrder(OrderId id, Side side, OrderType type, Price price, Quantity qty, Timestamp ts = 0) {
        return addOrder(id, 1, side, type, price, qty, 0, SelfTradePrevention::NONE, ts);
    }

    bool cancelOrder(OrderId id);
    bool modifyOrder(OrderId id, Quantity new_qty);

    // Queries
    [[nodiscard]] const std::string& getSymbol() const noexcept { return symbol_; }
    [[nodiscard]] Price getBestBid() const noexcept;
    [[nodiscard]] Price getBestAsk() const noexcept;
    [[nodiscard]] Price getSpread() const noexcept;
    [[nodiscard]] Price getMidPrice() const noexcept;
    [[nodiscard]] size_t getActiveOrderCount() const noexcept { return order_index_.size(); }

    // Level-2 Market Depth Snapshot
    [[nodiscard]] Level2Snapshot getLevel2Snapshot(size_t max_depth = 12) const;

    void setTradeCallback(TradeCallback callback) { on_trade_ = std::move(callback); }

private:
    void matchLimitOrder(Order* taker);
    void matchMarketOrder(Order* taker);
    bool canFillFOK(Side side, Price price, Quantity qty) const;
    void executeTrade(Order* maker, Order* taker, Price price, Quantity match_qty);
    void handleIcebergReplenish(Order* order, PriceLevel& level);

    std::string symbol_;
    TradeCallback on_trade_;

    std::map<Price, PriceLevel, std::greater<Price>> bids_;
    std::map<Price, PriceLevel, std::less<Price>> asks_;
    std::unordered_map<OrderId, Order*> order_index_;
    ObjectPool<Order> order_pool_;
};

} // namespace Engine
