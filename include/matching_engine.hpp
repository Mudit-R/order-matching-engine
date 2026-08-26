#pragma once

#include <unordered_map>
#include <string>
#include <memory>
#include <thread>
#include <atomic>
#include "types.hpp"
#include "order_book.hpp"
#include "lockfree_ring_buffer.hpp"

namespace Engine {

struct OrderCommand {
    OrderAction action{OrderAction::NEW};
    OrderId id{0};
    char symbol[16]{0};
    Side side{Side::BUY};
    OrderType type{OrderType::LIMIT};
    Price price{0};
    Quantity quantity{0};
    Timestamp timestamp{0};
};

struct EngineEvent {
    enum class Type : uint8_t {
        TRADE = 0,
        ORDER_ACCEPTED = 1,
        ORDER_REJECTED = 2,
        ORDER_CANCELLED = 3,
        DEPTH_UPDATE = 4
    } type{Type::ORDER_ACCEPTED};

    OrderId order_id{0};
    char symbol[16]{0};
    Trade trade{};
    Timestamp timestamp{0};
};

/**
 * @brief High-Throughput Matching Engine Orchestrator.
 * Encapsulates dedicated matching worker threads, lock-free ring buffers for inbound orders
 * and outbound events, and multi-symbol order book management.
 */
class MatchingEngine {
public:
    explicit MatchingEngine(size_t ring_buffer_capacity = 1048576);
    ~MatchingEngine();

    void registerSymbol(const std::string& symbol);
    
    // Non-blocking submission to Lock-Free SPSC queue
    bool submitCommand(const OrderCommand& cmd);

    // Lifecycle
    void start();
    void stop();

    // Query state
    LimitOrderBook* getBook(const std::string& symbol);
    uint64_t getProcessedOrderCount() const noexcept { return processed_orders_.load(std::memory_order_relaxed); }
    uint64_t getExecutedTradeCount() const noexcept { return executed_trades_.load(std::memory_order_relaxed); }

    // Event consumption from matching core
    bool pollEvent(EngineEvent& event) {
        return outbound_events_.pop(event);
    }

private:
    void runProcessingLoop();

    std::unordered_map<std::string, std::unique_ptr<LimitOrderBook>> books_;
    LockFreeRingBuffer<OrderCommand, 1048576> inbound_commands_;
    LockFreeRingBuffer<EngineEvent, 1048576> outbound_events_;

    std::thread worker_thread_;
    std::atomic<bool> running_{false};

    std::atomic<uint64_t> processed_orders_{0};
    std::atomic<uint64_t> executed_trades_{0};
};

} // namespace Engine
