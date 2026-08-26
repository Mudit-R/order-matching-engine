#include "../include/order_book.hpp"
#include <algorithm>
#include <iostream>

namespace Engine {

LimitOrderBook::LimitOrderBook(std::string symbol, TradeCallback on_trade)
    : symbol_(std::move(symbol)), on_trade_(std::move(on_trade)) {}

LimitOrderBook::~LimitOrderBook() {
    for (auto& [id, order] : order_index_) {
        order_pool_.release(order);
    }
    order_index_.clear();
}

Price LimitOrderBook::getBestBid() const noexcept {
    if (bids_.empty()) return 0;
    return bids_.begin()->first;
}

Price LimitOrderBook::getBestAsk() const noexcept {
    if (asks_.empty()) return 0;
    return asks_.begin()->first;
}

Price LimitOrderBook::getSpread() const noexcept {
    Price best_bid = getBestBid();
    Price best_ask = getBestAsk();
    if (best_bid == 0 || best_ask == 0 || best_ask < best_bid) return 0;
    return best_ask - best_bid;
}

Price LimitOrderBook::getMidPrice() const noexcept {
    Price best_bid = getBestBid();
    Price best_ask = getBestAsk();
    if (best_bid == 0 || best_ask == 0) return 0;
    return (best_bid + best_ask) / 2;
}

bool LimitOrderBook::canFillFOK(Side side, Price price, Quantity target_qty) const {
    Quantity cumulative_qty = 0;
    if (side == Side::BUY) {
        for (const auto& [ask_price, level] : asks_) {
            if (ask_price > price) break;
            cumulative_qty += level.total_quantity;
            if (cumulative_qty >= target_qty) return true;
        }
    } else {
        for (const auto& [bid_price, level] : bids_) {
            if (bid_price < price) break;
            cumulative_qty += level.total_quantity;
            if (cumulative_qty >= target_qty) return true;
        }
    }
    return false;
}

bool LimitOrderBook::addOrder(OrderId id, ClientId client_id, Side side, OrderType type,
                              Price price, Quantity qty, Quantity display_qty,
                              SelfTradePrevention stp, Timestamp ts) {
    if (qty == 0 || order_index_.find(id) != order_index_.end()) {
        return false;
    }

    if (ts == 0) {
        ts = getCurrentTimestampNs();
    }

    // Post-Only check: Reject if it would cross the spread and take liquidity
    if (type == OrderType::POST_ONLY) {
        if (side == Side::BUY && getBestAsk() > 0 && price >= getBestAsk()) {
            return false; // Would cross ask -> Reject
        }
        if (side == Side::SELL && getBestBid() > 0 && price <= getBestBid()) {
            return false; // Would cross bid -> Reject
        }
    }

    // Fill-Or-Kill (FOK) pre-check
    if (type == OrderType::FOK) {
        if (!canFillFOK(side, price, qty)) {
            return false;
        }
    }

    Order* order = order_pool_.acquire();
    order->id = id;
    order->client_id = client_id;
    order->price = price;
    order->initial_qty = qty;
    order->remaining_qty = qty;
    order->side = side;
    order->type = type;
    order->stp = stp;
    order->timestamp = ts;
    order->prev = nullptr;
    order->next = nullptr;

    // Handle Iceberg slice
    if (display_qty > 0 && display_qty < qty) {
        order->display_qty = display_qty;
        order->hidden_qty = qty - display_qty;
        order->remaining_qty = display_qty; // Visible in queue
    } else {
        order->display_qty = qty;
        order->hidden_qty = 0;
    }

    if (type == OrderType::MARKET) {
        matchMarketOrder(order);
        order_pool_.release(order);
        return true;
    }

    // Match against opposing book
    matchLimitOrder(order);

    if (order->is_filled() && order->hidden_qty == 0) {
        order_pool_.release(order);
        return true;
    }

    if (type == OrderType::IOC || type == OrderType::FOK) {
        order_pool_.release(order);
        return true;
    }

    // Rest unfilled quantity on the book (GTC / Post-Only)
    order_index_[id] = order;
    if (side == Side::BUY) {
        auto& level = bids_[price];
        level.price = price;
        level.append(order);
    } else {
        auto& level = asks_[price];
        level.price = price;
        level.append(order);
    }

    return true;
}

void LimitOrderBook::matchLimitOrder(Order* taker) {
    if (taker->side == Side::BUY) {
        auto it = asks_.begin();
        while (it != asks_.end() && !taker->is_filled()) {
            Price ask_price = it->first;
            if (ask_price > taker->price) {
                break;
            }

            PriceLevel& level = it->second;
            Order* maker = level.head;

            while (maker != nullptr && !taker->is_filled()) {
                Order* next_maker = maker->next;

                // Self-Trade Prevention (STP) check
                if (maker->client_id == taker->client_id && taker->stp != SelfTradePrevention::NONE) {
                    if (taker->stp == SelfTradePrevention::CANCEL_TAKER) {
                        taker->remaining_qty = 0;
                        taker->hidden_qty = 0;
                        return;
                    } else if (taker->stp == SelfTradePrevention::CANCEL_MAKER) {
                        order_index_.erase(maker->id);
                        level.remove(maker);
                        order_pool_.release(maker);
                        maker = next_maker;
                        continue;
                    }
                }

                Quantity match_qty = std::min(taker->remaining_qty, maker->remaining_qty);
                executeTrade(maker, taker, ask_price, match_qty);

                if (maker->is_filled()) {
                    if (maker->hidden_qty > 0) {
                        handleIcebergReplenish(maker, level);
                    } else {
                        order_index_.erase(maker->id);
                        level.remove(maker);
                        order_pool_.release(maker);
                    }
                }
                maker = next_maker;
            }

            if (level.order_count == 0) {
                it = asks_.erase(it);
            } else {
                ++it;
            }
        }
    } else { // SELL Taker
        auto it = bids_.begin();
        while (it != bids_.end() && !taker->is_filled()) {
            Price bid_price = it->first;
            if (bid_price < taker->price) {
                break;
            }

            PriceLevel& level = it->second;
            Order* maker = level.head;

            while (maker != nullptr && !taker->is_filled()) {
                Order* next_maker = maker->next;

                if (maker->client_id == taker->client_id && taker->stp != SelfTradePrevention::NONE) {
                    if (taker->stp == SelfTradePrevention::CANCEL_TAKER) {
                        taker->remaining_qty = 0;
                        taker->hidden_qty = 0;
                        return;
                    } else if (taker->stp == SelfTradePrevention::CANCEL_MAKER) {
                        order_index_.erase(maker->id);
                        level.remove(maker);
                        order_pool_.release(maker);
                        maker = next_maker;
                        continue;
                    }
                }

                Quantity match_qty = std::min(taker->remaining_qty, maker->remaining_qty);
                executeTrade(maker, taker, bid_price, match_qty);

                if (maker->is_filled()) {
                    if (maker->hidden_qty > 0) {
                        handleIcebergReplenish(maker, level);
                    } else {
                        order_index_.erase(maker->id);
                        level.remove(maker);
                        order_pool_.release(maker);
                    }
                }
                maker = next_maker;
            }

            if (level.order_count == 0) {
                it = bids_.erase(it);
            } else {
                ++it;
            }
        }
    }
}

void LimitOrderBook::handleIcebergReplenish(Order* order, PriceLevel& level) {
    Quantity replenish_qty = std::min(order->display_qty, order->hidden_qty);
    order->hidden_qty -= replenish_qty;
    order->remaining_qty = replenish_qty;

    // Move to the back of the queue (gives up time-priority for newly displayed tranche)
    level.remove(order);
    level.append(order);
}

void LimitOrderBook::matchMarketOrder(Order* taker) {
    if (taker->side == Side::BUY) {
        auto it = asks_.begin();
        while (it != asks_.end() && !taker->is_filled()) {
            Price ask_price = it->first;
            PriceLevel& level = it->second;
            Order* maker = level.head;

            while (maker != nullptr && !taker->is_filled()) {
                Order* next_maker = maker->next;
                Quantity match_qty = std::min(taker->remaining_qty, maker->remaining_qty);
                executeTrade(maker, taker, ask_price, match_qty);

                if (maker->is_filled()) {
                    if (maker->hidden_qty > 0) {
                        handleIcebergReplenish(maker, level);
                    } else {
                        order_index_.erase(maker->id);
                        level.remove(maker);
                        order_pool_.release(maker);
                    }
                }
                maker = next_maker;
            }

            if (level.order_count == 0) {
                it = asks_.erase(it);
            } else {
                ++it;
            }
        }
    } else {
        auto it = bids_.begin();
        while (it != bids_.end() && !taker->is_filled()) {
            Price bid_price = it->first;
            PriceLevel& level = it->second;
            Order* maker = level.head;

            while (maker != nullptr && !taker->is_filled()) {
                Order* next_maker = maker->next;
                Quantity match_qty = std::min(taker->remaining_qty, maker->remaining_qty);
                executeTrade(maker, taker, bid_price, match_qty);

                if (maker->is_filled()) {
                    if (maker->hidden_qty > 0) {
                        handleIcebergReplenish(maker, level);
                    } else {
                        order_index_.erase(maker->id);
                        level.remove(maker);
                        order_pool_.release(maker);
                    }
                }
                maker = next_maker;
            }

            if (level.order_count == 0) {
                it = bids_.erase(it);
            } else {
                ++it;
            }
        }
    }
}

void LimitOrderBook::executeTrade(Order* maker, Order* taker, Price price, Quantity match_qty) {
    maker->remaining_qty -= match_qty;
    taker->remaining_qty -= match_qty;

    if (on_trade_) {
        Trade trade;
        trade.maker_order_id = maker->id;
        trade.taker_order_id = taker->id;
        trade.maker_client_id = maker->client_id;
        trade.taker_client_id = taker->client_id;
        trade.price = price;
        trade.quantity = match_qty;
        trade.taker_side = taker->side;
        trade.timestamp = getCurrentTimestampNs();
        on_trade_(trade);
    }
}

bool LimitOrderBook::cancelOrder(OrderId id) {
    auto it = order_index_.find(id);
    if (it == order_index_.end()) {
        return false;
    }

    Order* order = it->second;
    order_index_.erase(it);

    if (order->side == Side::BUY) {
        auto level_it = bids_.find(order->price);
        if (level_it != bids_.end()) {
            level_it->second.remove(order);
            if (level_it->second.order_count == 0) {
                bids_.erase(level_it);
            }
        }
    } else {
        auto level_it = asks_.find(order->price);
        if (level_it != asks_.end()) {
            level_it->second.remove(order);
            if (level_it->second.order_count == 0) {
                asks_.erase(level_it);
            }
        }
    }

    order_pool_.release(order);
    return true;
}

bool LimitOrderBook::modifyOrder(OrderId id, Quantity new_qty) {
    auto it = order_index_.find(id);
    if (it == order_index_.end()) {
        return false;
    }

    Order* order = it->second;
    if (new_qty == 0) {
        return cancelOrder(id);
    }

    if (new_qty < order->remaining_qty) {
        Quantity diff = order->remaining_qty - new_qty;
        order->remaining_qty = new_qty;
        if (order->side == Side::BUY) {
            bids_[order->price].total_quantity -= diff;
        } else {
            asks_[order->price].total_quantity -= diff;
        }
        return true;
    }

    Side side = order->side;
    OrderType type = order->type;
    Price price = order->price;
    cancelOrder(id);
    return addOrder(id, side, type, price, new_qty);
}

Level2Snapshot LimitOrderBook::getLevel2Snapshot(size_t max_depth) const {
    Level2Snapshot snapshot;
    snapshot.symbol = symbol_;
    snapshot.timestamp = getCurrentTimestampNs();

    snapshot.bids.reserve(max_depth);
    size_t count = 0;
    for (const auto& [price, level] : bids_) {
        if (count++ >= max_depth) break;
        snapshot.bids.push_back({price, level.total_quantity, level.order_count});
    }

    snapshot.asks.reserve(max_depth);
    count = 0;
    for (const auto& [price, level] : asks_) {
        if (count++ >= max_depth) break;
        snapshot.asks.push_back({price, level.total_quantity, level.order_count});
    }

    return snapshot;
}

} // namespace Engine
