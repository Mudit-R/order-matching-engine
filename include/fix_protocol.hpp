#pragma once

#include <string>
#include <string_view>
#include <unordered_map>
#include <sstream>
#include <iomanip>
#include <cstdint>
#include "types.hpp"

namespace Engine {

/**
 * @brief Zero-allocation / Low-latency Financial Information eXchange (FIX 4.2) Protocol Parser & Serializer.
 * Supports standard tags: 35 (MsgType), 11 (ClOrdID), 55 (Symbol), 54 (Side), 38 (OrderQty), 44 (Price), 40 (OrdType), 150 (ExecType).
 */
class FIXProtocol {
public:
    static constexpr char SOH = '\x01'; // Standard FIX delimiter

    struct Message {
        std::string msg_type; // 'D' = NewOrderSingle, 'F' = OrderCancelRequest, '8' = ExecutionReport
        std::string cl_ord_id;
        std::string orig_cl_ord_id;
        std::string symbol;
        Side side{Side::BUY};
        OrderType ord_type{OrderType::LIMIT};
        Price price{0};
        Quantity order_qty{0};
        ClientId client_id{1};
    };

    /**
     * @brief Parse raw FIX 4.2 tag-value string (with SOH or pipe '|' delimiters)
     */
    static bool parse(std::string_view raw_fix, Message& msg) {
        if (raw_fix.empty()) return false;

        size_t start = 0;
        while (start < raw_fix.size()) {
            size_t eq_pos = raw_fix.find('=', start);
            if (eq_pos == std::string_view::npos) break;

            size_t delim_pos = raw_fix.find_first_of("\x01|", eq_pos);
            if (delim_pos == std::string_view::npos) delim_pos = raw_fix.size();

            std::string_view tag = raw_fix.substr(start, eq_pos - start);
            std::string_view val = raw_fix.substr(eq_pos + 1, delim_pos - eq_pos - 1);

            if (tag == "35") {
                msg.msg_type = std::string(val);
            } else if (tag == "11") {
                msg.cl_ord_id = std::string(val);
            } else if (tag == "41") {
                msg.orig_cl_ord_id = std::string(val);
            } else if (tag == "55") {
                msg.symbol = std::string(val);
            } else if (tag == "54") {
                msg.side = (val == "1") ? Side::BUY : Side::SELL;
            } else if (tag == "38") {
                msg.order_qty = static_cast<Quantity>(std::stoul(std::string(val)));
            } else if (tag == "44") {
                double p = std::stod(std::string(val));
                msg.price = static_cast<Price>(p * 100.0 + 0.5);
            } else if (tag == "40") {
                if (val == "1") msg.ord_type = OrderType::MARKET;
                else if (val == "2") msg.ord_type = OrderType::LIMIT;
                else if (val == "3") msg.ord_type = OrderType::IOC;
                else if (val == "4") msg.ord_type = OrderType::FOK;
            }

            start = delim_pos + 1;
        }
        return true;
    }

    /**
     * @brief Serialize Trade into a FIX 4.2 ExecutionReport (35=8)
     */
    static std::string serializeExecutionReport(const std::string& symbol, const Trade& trade, const std::string& cl_ord_id) {
        std::ostringstream ss;
        ss << "8=FIX.4.2" << SOH
           << "9=140" << SOH
           << "35=8" << SOH                  // ExecutionReport
           << "49=NEXUS_ENGINE" << SOH
           << "56=CLIENT" << SOH
           << "11=" << cl_ord_id << SOH      // Client Order ID
           << "17=" << trade.timestamp << SOH // ExecID
           << "150=2" << SOH                 // ExecType = Fill
           << "39=2" << SOH                  // OrdStatus = Filled
           << "55=" << symbol << SOH         // Symbol
           << "54=" << (trade.taker_side == Side::BUY ? "1" : "2") << SOH
           << "38=" << trade.quantity << SOH // OrderQty
           << "44=" << formatPrice(trade.price) << SOH
           << "32=" << trade.quantity << SOH // LastShares
           << "31=" << formatPrice(trade.price) << SOH // LastPx
           << "10=000" << SOH;
        return ss.str();
    }
};

} // namespace Engine
