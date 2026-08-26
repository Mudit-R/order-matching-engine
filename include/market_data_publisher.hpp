#pragma once

#include <string>
#include <sstream>
#include <vector>
#include "types.hpp"

namespace Engine {

class MarketDataPublisher {
public:
    static std::string serializeL2SnapshotJSON(const Level2Snapshot& snapshot) {
        std::ostringstream ss;
        ss << "{\"type\":\"L2_SNAPSHOT\",\"symbol\":\"" << snapshot.symbol
           << "\",\"timestamp\":" << snapshot.timestamp
           << ",\"bids\":[";
        
        for (size_t i = 0; i < snapshot.bids.size(); ++i) {
            if (i > 0) ss << ",";
            ss << "{\"price\":" << snapshot.bids[i].price
               << ",\"qty\":" << snapshot.bids[i].total_quantity
               << ",\"orders\":" << snapshot.bids[i].order_count << "}";
        }
        ss << "],\"asks\":[";
        for (size_t i = 0; i < snapshot.asks.size(); ++i) {
            if (i > 0) ss << ",";
            ss << "{\"price\":" << snapshot.asks[i].price
               << ",\"qty\":" << snapshot.asks[i].total_quantity
               << ",\"orders\":" << snapshot.asks[i].order_count << "}";
        }
        ss << "]}";
        return ss.str();
    }

    static std::string serializeTradeJSON(const std::string& symbol, const Trade& trade) {
        std::ostringstream ss;
        ss << "{\"type\":\"TRADE\",\"symbol\":\"" << symbol
           << "\",\"maker_id\":" << trade.maker_order_id
           << ",\"taker_id\":" << trade.taker_order_id
           << ",\"price\":" << trade.price
           << ",\"qty\":" << trade.quantity
           << ",\"taker_side\":\"" << (trade.taker_side == Side::BUY ? "BUY" : "SELL")
           << "\",\"timestamp\":" << trade.timestamp << "}";
        return ss.str();
    }
};

} // namespace Engine
