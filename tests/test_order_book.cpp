#include <iostream>
#include <cassert>
#include <vector>
#include "../include/order_book.hpp"

using namespace Engine;

void testBasicLimitMatching() {
    std::cout << "[TEST] Running testBasicLimitMatching..." << std::endl;
    std::vector<Trade> trades;
    LimitOrderBook book("NIFTY50", [&](const Trade& t) {
        trades.push_back(t);
    });

    // Add Maker Sell: 100 shares @ $150.00 (15000)
    assert(book.addOrder(1, Side::SELL, OrderType::LIMIT, 15000, 100));
    assert(book.getBestAsk() == 15000);
    assert(book.getActiveOrderCount() == 1);

    // Add Taker Buy: 50 shares @ $150.00 -> Partial Fill
    assert(book.addOrder(2, Side::BUY, OrderType::LIMIT, 15000, 50));
    assert(trades.size() == 1);
    assert(trades[0].quantity == 50);
    assert(trades[0].price == 15000);
    assert(trades[0].maker_order_id == 1);
    assert(trades[0].taker_order_id == 2);
    assert(book.getActiveOrderCount() == 1); // Maker order still has 50 shares left

    // Add Taker Buy: 50 shares @ $150.00 -> Complete Fill
    assert(book.addOrder(3, Side::BUY, OrderType::LIMIT, 15000, 50));
    assert(trades.size() == 2);
    assert(trades[1].quantity == 50);
    assert(book.getActiveOrderCount() == 0); // Book completely cleared
    assert(book.getBestAsk() == 0);

    std::cout << "  -> PASSED" << std::endl;
}

void testPriceTimePriorityFIFO() {
    std::cout << "[TEST] Running testPriceTimePriorityFIFO..." << std::endl;
    std::vector<Trade> trades;
    LimitOrderBook book("RELIANCE", [&](const Trade& t) {
        trades.push_back(t);
    });

    // Two sell orders at the exact same price: $250.00
    // Order 1 arrived first (50 qty), Order 2 arrived second (50 qty)
    book.addOrder(101, Side::SELL, OrderType::LIMIT, 25000, 50);
    book.addOrder(102, Side::SELL, OrderType::LIMIT, 25000, 50);

    // Incoming aggressive buy order for 60 shares
    book.addOrder(201, Side::BUY, OrderType::LIMIT, 25000, 60);

    // Order 101 must be matched first in full (50 shares), then Order 102 matched partially (10 shares)
    assert(trades.size() == 2);
    assert(trades[0].maker_order_id == 101);
    assert(trades[0].quantity == 50);

    assert(trades[1].maker_order_id == 102);
    assert(trades[1].quantity == 10);

    assert(book.getActiveOrderCount() == 1); // Order 102 has 40 shares left
    std::cout << "  -> PASSED" << std::endl;
}

void testCancelAndModify() {
    std::cout << "[TEST] Running testCancelAndModify..." << std::endl;
    LimitOrderBook book("TCS");

    book.addOrder(1, Side::BUY, OrderType::LIMIT, 35000, 100);
    assert(book.getActiveOrderCount() == 1);
    assert(book.getBestBid() == 35000);

    // Modify quantity downwards
    assert(book.modifyOrder(1, 40));
    auto snap = book.getLevel2Snapshot();
    assert(snap.bids[0].total_quantity == 40);

    // Cancel order
    assert(book.cancelOrder(1));
    assert(book.getActiveOrderCount() == 0);
    assert(book.getBestBid() == 0);

    std::cout << "  -> PASSED" << std::endl;
}

void testIOCAndFOK() {
    std::cout << "[TEST] Running testIOCAndFOK..." << std::endl;
    std::vector<Trade> trades;
    LimitOrderBook book("INFY", [&](const Trade& t) {
        trades.push_back(t);
    });

    book.addOrder(1, Side::SELL, OrderType::LIMIT, 18000, 50);

    // FOK Buy for 100 shares -> Should fail and reject immediately because only 50 available
    assert(!book.addOrder(2, Side::BUY, OrderType::FOK, 18000, 100));
    assert(trades.empty());
    assert(book.getActiveOrderCount() == 1);

    // IOC Buy for 100 shares -> Should match 50 and cancel remaining 50 without resting
    assert(book.addOrder(3, Side::BUY, OrderType::IOC, 18000, 100));
    assert(trades.size() == 1);
    assert(trades[0].quantity == 50);
    assert(book.getActiveOrderCount() == 0); // Nothing rests on book

    std::cout << "  -> PASSED" << std::endl;
}

int main() {
    std::cout << "========================================" << std::endl;
    std::cout << "  Matching Engine Core Unit Test Suite  " << std::endl;
    std::cout << "========================================" << std::endl;

    testBasicLimitMatching();
    testPriceTimePriorityFIFO();
    testCancelAndModify();
    testIOCAndFOK();

    std::cout << "\nALL 4 TEST SUITES PASSED PERFECTLY!\n" << std::endl;
    return 0;
}
