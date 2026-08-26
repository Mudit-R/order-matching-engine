#include <iostream>
#include <vector>
#include <chrono>
#include <random>
#include <numeric>
#include <algorithm>
#include <iomanip>
#include "../include/order_book.hpp"

using namespace Engine;

struct LatencyStats {
    double min_us;
    double max_us;
    double avg_us;
    double p50_us;
    double p90_us;
    double p99_us;
    double p999_us;
    double throughput_ops_sec;
};

LatencyStats runBenchmark(size_t total_orders = 1000000) {
    LimitOrderBook book("NIFTY_FUT");
    std::vector<double> latencies_us;
    latencies_us.reserve(total_orders);

    std::mt19937_64 rng(42);
    std::uniform_int_distribution<Price> price_dist(19800, 20200); // Ticks around 200.00
    std::uniform_int_distribution<Quantity> qty_dist(10, 500);
    std::uniform_int_distribution<int> side_dist(0, 1);
    std::uniform_int_distribution<int> type_dist(0, 10);

    auto start_total = std::chrono::high_resolution_clock::now();

    for (size_t i = 1; i <= total_orders; ++i) {
        Side side = (side_dist(rng) == 0) ? Side::BUY : Side::SELL;
        Price price = price_dist(rng);
        Quantity qty = qty_dist(rng);
        OrderType type = (type_dist(rng) == 0) ? OrderType::MARKET : OrderType::LIMIT;

        auto t0 = std::chrono::high_resolution_clock::now();
        book.addOrder(i, side, type, price, qty);
        auto t1 = std::chrono::high_resolution_clock::now();

        double elapsed_us = std::chrono::duration<double, std::micro>(t1 - t0).count();
        latencies_us.push_back(elapsed_us);
    }

    auto end_total = std::chrono::high_resolution_clock::now();
    double total_time_sec = std::chrono::duration<double>(end_total - start_total).count();

    std::sort(latencies_us.begin(), latencies_us.end());

    double sum = std::accumulate(latencies_us.begin(), latencies_us.end(), 0.0);
    LatencyStats stats;
    stats.min_us = latencies_us.front();
    stats.max_us = latencies_us.back();
    stats.avg_us = sum / total_orders;
    stats.p50_us = latencies_us[static_cast<size_t>(total_orders * 0.50)];
    stats.p90_us = latencies_us[static_cast<size_t>(total_orders * 0.90)];
    stats.p99_us = latencies_us[static_cast<size_t>(total_orders * 0.99)];
    stats.p999_us = latencies_us[static_cast<size_t>(total_orders * 0.999)];
    stats.throughput_ops_sec = static_cast<double>(total_orders) / total_time_sec;

    return stats;
}

int main() {
    constexpr size_t TOTAL_ORDERS = 1000000;
    std::cout << "==========================================================" << std::endl;
    std::cout << " High-Throughput Matching Engine Latency & Throughput Benchmark " << std::endl;
    std::cout << " Orders to Process: " << TOTAL_ORDERS << std::endl;
    std::cout << "==========================================================" << std::endl;

    std::cout << "Running benchmark (warming up cache and object pools)..." << std::endl;
    LatencyStats stats = runBenchmark(TOTAL_ORDERS);

    std::cout << std::fixed << std::setprecision(3);
    std::cout << "\n---------------- Benchmark Results ----------------" << std::endl;
    std::cout << "Throughput:       " << static_cast<uint64_t>(stats.throughput_ops_sec) << " orders/second" << std::endl;
    std::cout << "Average Latency:  " << stats.avg_us << " µs" << std::endl;
    std::cout << "Min Latency:      " << stats.min_us << " µs" << std::endl;
    std::cout << "P50 Latency:      " << stats.p50_us << " µs" << std::endl;
    std::cout << "P90 Latency:      " << stats.p90_us << " µs" << std::endl;
    std::cout << "P99 Latency:      " << stats.p99_us << " µs" << std::endl;
    std::cout << "P99.9 Latency:    " << stats.p999_us << " µs" << std::endl;
    std::cout << "Max Latency:      " << stats.max_us << " µs" << std::endl;
    std::cout << "---------------------------------------------------" << std::endl;

    return 0;
}
