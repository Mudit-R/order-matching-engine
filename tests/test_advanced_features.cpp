#include <iostream>
#include <cassert>
#include <vector>
#include "../include/order_book.hpp"
#include "../include/fix_protocol.hpp"
#include "../include/wal_logger.hpp"

using namespace Engine;

void testIcebergOrders() {
    std::cout << "[TEST] Running Iceberg Order Replenish Suite..." << std::endl;
    std::vector<Trade> trades;
    LimitOrderBook book("NIFTY50", [&](const Trade& t) { trades.push_back(t); });

    // Add Iceberg Sell: Total 500 qty, Visible Display Qty 100 @ $195.00
    assert(book.addOrder(1, 101, Side::SELL, OrderType::LIMIT, 19500, 500, 100));
    auto snap1 = book.getLevel2Snapshot();
    assert(snap1.asks[0].total_quantity == 100); // Only 100 visible

    // Add standard Sell: 50 qty @ $195.00 (arrives after Iceberg tranche 1)
    assert(book.addOrder(2, 102, Side::SELL, OrderType::LIMIT, 19500, 50));
    auto snap2 = book.getLevel2Snapshot();
    assert(snap2.asks[0].total_quantity == 150);

    // Incoming aggressive Buy for 100 shares -> matches tranche 1 of Iceberg
    assert(book.addOrder(3, 103, Side::BUY, OrderType::LIMIT, 19500, 100));
    assert(trades.size() == 1);
    assert(trades[0].maker_order_id == 1);
    assert(trades[0].quantity == 100);

    // Iceberg tranche 1 exhausted -> auto-replenishes 100 shares from hidden reserve!
    // But it must be placed BEHIND Order 2 in time priority!
    auto snap3 = book.getLevel2Snapshot();
    assert(snap3.asks[0].total_quantity == 150); // 50 from Order 2 + 100 from replenished Iceberg

    // Next Buy for 50 shares MUST fill Order 2 first (strict FIFO priority preserved)
    assert(book.addOrder(4, 104, Side::BUY, OrderType::LIMIT, 19500, 50));
    assert(trades.size() == 2);
    assert(trades[1].maker_order_id == 2); // Order 2 was ahead of replenished tranche!
    assert(trades[1].quantity == 50);

    std::cout << "  -> PASSED" << std::endl;
}

void testPostOnlyAndSTP() {
    std::cout << "[TEST] Running Post-Only & Self-Trade Prevention (STP) Suite..." << std::endl;
    std::vector<Trade> trades;
    LimitOrderBook book("BANKNIFTY", [&](const Trade& t) { trades.push_back(t); });

    // Client 1 places resting Ask @ 440.00
    book.addOrder(1, 10, Side::SELL, OrderType::LIMIT, 44000, 100);

    // Client 2 places POST_ONLY Buy @ 440.00 -> Would cross ask -> MUST REJECT
    assert(!book.addOrder(2, 20, Side::BUY, OrderType::POST_ONLY, 44000, 50));
    assert(book.getActiveOrderCount() == 1);

    // Client 2 places POST_ONLY Buy @ 439.00 -> Does not cross -> MUST ACCEPT
    assert(book.addOrder(3, 20, Side::BUY, OrderType::POST_ONLY, 43900, 50));
    assert(book.getActiveOrderCount() == 2);

    // Client 1 (same client) places Buy @ 440.00 with CANCEL_TAKER STP -> Must cancel taker to avoid self-match
    assert(book.addOrder(4, 10, Side::BUY, OrderType::LIMIT, 44000, 20, 0, SelfTradePrevention::CANCEL_TAKER));
    assert(trades.empty()); // No trade occurred!
    assert(book.getActiveOrderCount() == 2); // Resting maker still remains

    std::cout << "  -> PASSED" << std::endl;
}

void testFIXProtocol() {
    std::cout << "[TEST] Running FIX 4.2 Protocol Parser & Serializer Suite..." << std::endl;
    std::string raw_fix = "8=FIX.4.2|35=D|11=ORD12345|55=NIFTY50|54=1|38=250|44=195.50|40=2|";
    FIXProtocol::Message msg;
    assert(FIXProtocol::parse(raw_fix, msg));
    assert(msg.msg_type == "D");
    assert(msg.cl_ord_id == "ORD12345");
    assert(msg.symbol == "NIFTY50");
    assert(msg.side == Side::BUY);
    assert(msg.order_qty == 250);
    assert(msg.price == 19550);
    assert(msg.ord_type == OrderType::LIMIT);

    Trade t{1001, 1002, 1, 2, 19550, 250, Side::BUY, 1724670000000000000ULL, true};
    std::string exec_rpt = FIXProtocol::serializeExecutionReport("NIFTY50", t, "ORD12345");
    assert(exec_rpt.find("35=8") != std::string::npos);
    assert(exec_rpt.find("11=ORD12345") != std::string::npos);
    assert(exec_rpt.find("44=195.50") != std::string::npos);

    std::cout << "  -> PASSED" << std::endl;
}

void testWALEventSourcing() {
    std::cout << "[TEST] Running Write-Ahead-Log (WAL) Replay Suite..." << std::endl;
    std::string wal_path = "test_audit.wal";
    {
        WALLogger wal(wal_path);
        wal.logOrderNew(1, 10, "RELIANCE", Side::BUY, OrderType::LIMIT, 25000, 100, 0, 1000);
        wal.logOrderNew(2, 11, "RELIANCE", Side::SELL, OrderType::LIMIT, 25000, 50, 0, 1001);
        wal.logOrderCancel(1, "RELIANCE", 1002);
    }

    auto records = WALLogger::replay(wal_path);
    assert(records.size() == 3);
    assert(records[0].order_id == 1 && records[0].action == 0 && records[0].price == 25000);
    assert(records[1].order_id == 2 && records[1].action == 0 && records[1].quantity == 50);
    assert(records[2].order_id == 1 && records[2].action == 1);

    std::remove(wal_path.c_str());
    std::cout << "  -> PASSED" << std::endl;
}

int main() {
    std::cout << "=======================================================" << std::endl;
    std::cout << " Advanced Institutional Matching Features Test Suite  " << std::endl;
    std::cout << "=======================================================" << std::endl;

    testIcebergOrders();
    testPostOnlyAndSTP();
    testFIXProtocol();
    testWALEventSourcing();

    std::cout << "\n>>> ALL ADVANCED INSTITUTIONAL SUITES PASSED! <<<\n" << std::endl;
    return 0;
}
