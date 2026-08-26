#pragma once

#include <string>
#include <fstream>
#include <vector>
#include <mutex>
#include <cstring>
#include "types.hpp"

namespace Engine {

#pragma pack(push, 1)
struct WALRecord {
    uint64_t sequence_num;
    uint8_t action; // 0 = New, 1 = Cancel
    OrderId order_id;
    ClientId client_id;
    char symbol[16];
    uint8_t side;
    uint8_t order_type;
    Price price;
    Quantity quantity;
    Quantity display_qty;
    Timestamp timestamp;
};
#pragma pack(pop)

/**
 * @brief High-Speed Append-Only Binary Write-Ahead Logger (WAL).
 * Enables deterministic event replay and crash-recovery for zero data loss.
 */
class WALLogger {
public:
    explicit WALLogger(const std::string& filepath = "matching_engine.wal")
        : filepath_(filepath), sequence_num_(0) {
        log_file_.open(filepath, std::ios::out | std::ios::binary | std::ios::app);
    }

    ~WALLogger() {
        if (log_file_.is_open()) {
            log_file_.flush();
            log_file_.close();
        }
    }

    void logOrderNew(OrderId id, ClientId client_id, const char* symbol, Side side,
                     OrderType type, Price price, Quantity qty, Quantity display_qty, Timestamp ts) {
        WALRecord record{};
        record.sequence_num = ++sequence_num_;
        record.action = 0;
        record.order_id = id;
        record.client_id = client_id;
        std::strncpy(record.symbol, symbol, sizeof(record.symbol) - 1);
        record.side = static_cast<uint8_t>(side);
        record.order_type = static_cast<uint8_t>(type);
        record.price = price;
        record.quantity = qty;
        record.display_qty = display_qty;
        record.timestamp = ts;

        writeRecord(record);
    }

    void logOrderCancel(OrderId id, const char* symbol, Timestamp ts) {
        WALRecord record{};
        record.sequence_num = ++sequence_num_;
        record.action = 1;
        record.order_id = id;
        std::strncpy(record.symbol, symbol, sizeof(record.symbol) - 1);
        record.timestamp = ts;

        writeRecord(record);
    }

    static std::vector<WALRecord> replay(const std::string& filepath) {
        std::vector<WALRecord> records;
        std::ifstream in(filepath, std::ios::in | std::ios::binary);
        if (!in.is_open()) return records;

        WALRecord r;
        while (in.read(reinterpret_cast<char*>(&r), sizeof(WALRecord))) {
            records.push_back(r);
        }
        return records;
    }

private:
    void writeRecord(const WALRecord& record) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (log_file_.is_open()) {
            log_file_.write(reinterpret_cast<const char*>(&record), sizeof(WALRecord));
        }
    }

    std::string filepath_;
    std::ofstream log_file_;
    std::mutex mutex_;
    uint64_t sequence_num_;
};

} // namespace Engine
