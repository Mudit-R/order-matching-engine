#include <iostream>
#include <thread>
#include <chrono>
#include "../include/matching_engine.hpp"
#include "../include/market_data_publisher.hpp"

using namespace Engine;

int main() {
    std::cout << "==========================================================" << std::endl;
    std::cout << " High-Throughput Limit Order Book & Matching Engine Server " << std::endl;
    std::cout << "==========================================================" << std::endl;

    MatchingEngine engine;
    engine.registerSymbol("NIFTY50");
    engine.registerSymbol("BANKNIFTY");

    engine.start();
    std::cout << "[INFO] Matching engine worker thread started with Lock-Free SPSC queue." << std::endl;

    // Simulate placing initial limit orders
    OrderCommand c1{OrderAction::NEW, 1001, "NIFTY50", Side::BUY, OrderType::LIMIT, 19500, 100, getCurrentTimestampNs()};
    OrderCommand c2{OrderAction::NEW, 1002, "NIFTY50", Side::BUY, OrderType::LIMIT, 19480, 250, getCurrentTimestampNs()};
    OrderCommand c3{OrderAction::NEW, 1003, "NIFTY50", Side::SELL, OrderType::LIMIT, 19520, 150, getCurrentTimestampNs()};
    OrderCommand c4{OrderAction::NEW, 1004, "NIFTY50", Side::SELL, OrderType::LIMIT, 19550, 300, getCurrentTimestampNs()};

    engine.submitCommand(c1);
    engine.submitCommand(c2);
    engine.submitCommand(c3);
    engine.submitCommand(c4);

    // Allow worker to process
    std::this_thread::sleep_for(std::chrono::milliseconds(50));

    // Submit an aggressive crossing order that will trigger a match
    std::cout << "[INFO] Submitting crossing BUY market order for 100 shares..." << std::endl;
    OrderCommand c5{OrderAction::NEW, 1005, "NIFTY50", Side::BUY, OrderType::MARKET, 0, 100, getCurrentTimestampNs()};
    engine.submitCommand(c5);

    std::this_thread::sleep_for(std::chrono::milliseconds(50));

    // Drain and display outbound events
    EngineEvent evt;
    while (engine.pollEvent(evt)) {
        if (evt.type == EngineEvent::Type::TRADE) {
            std::cout << "  [EVENT: TRADE] Executed Trade on " << evt.symbol 
                      << " | Price: " << formatPrice(evt.trade.price) 
                      << " | Qty: " << evt.trade.quantity 
                      << " | Maker: " << evt.trade.maker_order_id 
                      << " | Taker: " << evt.trade.taker_order_id << std::endl;
        } else if (evt.type == EngineEvent::Type::ORDER_ACCEPTED) {
            std::cout << "  [EVENT: ACCEPTED] Order ID: " << evt.order_id << " accepted on " << evt.symbol << std::endl;
        }
    }

    // Print Level 2 snapshot
    LimitOrderBook* book = engine.getBook("NIFTY50");
    if (book) {
        Level2Snapshot snapshot = book->getLevel2Snapshot(5);
        std::cout << "\n[MARKET DATA JSON SNAPSHOT]:\n" << MarketDataPublisher::serializeL2SnapshotJSON(snapshot) << std::endl;
    }

    engine.stop();
    std::cout << "\n[INFO] Engine shutdown cleanly. Processed Orders: " 
              << engine.getProcessedOrderCount() 
              << ", Executed Trades: " << engine.getExecutedTradeCount() << std::endl;

    return 0;
}
