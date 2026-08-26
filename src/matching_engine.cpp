#include "../include/matching_engine.hpp"
#include <cstring>
#include <iostream>

namespace Engine {

MatchingEngine::MatchingEngine(size_t /*ring_buffer_capacity*/) {}

MatchingEngine::~MatchingEngine() {
    stop();
}

void MatchingEngine::registerSymbol(const std::string& symbol) {
    if (books_.find(symbol) == books_.end()) {
        auto book = std::make_unique<LimitOrderBook>(symbol, [this, symbol](const Trade& trade) {
            executed_trades_.fetch_add(1, std::memory_order_relaxed);
            EngineEvent evt;
            evt.type = EngineEvent::Type::TRADE;
            evt.order_id = trade.taker_order_id;
            std::strncpy(evt.symbol, symbol.c_str(), sizeof(evt.symbol) - 1);
            evt.trade = trade;
            evt.timestamp = getCurrentTimestampNs();
            outbound_events_.push(evt);
        });
        books_[symbol] = std::move(book);
    }
}

LimitOrderBook* MatchingEngine::getBook(const std::string& symbol) {
    auto it = books_.find(symbol);
    if (it != books_.end()) {
        return it->second.get();
    }
    return nullptr;
}

bool MatchingEngine::submitCommand(const OrderCommand& cmd) {
    return inbound_commands_.push(cmd);
}

void MatchingEngine::start() {
    if (!running_.exchange(true)) {
        worker_thread_ = std::thread(&MatchingEngine::runProcessingLoop, this);
    }
}

void MatchingEngine::stop() {
    if (running_.exchange(false)) {
        if (worker_thread_.joinable()) {
            worker_thread_.join();
        }
    }
}

void MatchingEngine::runProcessingLoop() {
    OrderCommand cmd;
    while (running_.load(std::memory_order_relaxed) || !inbound_commands_.empty()) {
        if (inbound_commands_.pop(cmd)) {
            processed_orders_.fetch_add(1, std::memory_order_relaxed);
            std::string sym(cmd.symbol);
            auto it = books_.find(sym);
            if (it == books_.end()) {
                EngineEvent evt;
                evt.type = EngineEvent::Type::ORDER_REJECTED;
                evt.order_id = cmd.id;
                std::strncpy(evt.symbol, cmd.symbol, sizeof(evt.symbol) - 1);
                evt.timestamp = getCurrentTimestampNs();
                outbound_events_.push(evt);
                continue;
            }

            LimitOrderBook* book = it->second.get();
            bool success = false;

            if (cmd.action == OrderAction::NEW) {
                success = book->addOrder(cmd.id, cmd.side, cmd.type, cmd.price, cmd.quantity, cmd.timestamp);
                EngineEvent evt;
                evt.type = success ? EngineEvent::Type::ORDER_ACCEPTED : EngineEvent::Type::ORDER_REJECTED;
                evt.order_id = cmd.id;
                std::strncpy(evt.symbol, cmd.symbol, sizeof(evt.symbol) - 1);
                evt.timestamp = getCurrentTimestampNs();
                outbound_events_.push(evt);
            } else if (cmd.action == OrderAction::CANCEL) {
                success = book->cancelOrder(cmd.id);
                EngineEvent evt;
                evt.type = success ? EngineEvent::Type::ORDER_CANCELLED : EngineEvent::Type::ORDER_REJECTED;
                evt.order_id = cmd.id;
                std::strncpy(evt.symbol, cmd.symbol, sizeof(evt.symbol) - 1);
                evt.timestamp = getCurrentTimestampNs();
                outbound_events_.push(evt);
            } else if (cmd.action == OrderAction::MODIFY) {
                success = book->modifyOrder(cmd.id, cmd.quantity);
            }
        } else {
            // Hot-spin yield to minimize wake-up latency
            std::this_thread::yield();
        }
    }
}

} // namespace Engine
