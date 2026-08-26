cmake_minimum_required(VERSION 3.20)
project(HighThroughputMatchingEngine VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Aggressive optimization flags for low latency
if(MSVC)
    add_compile_options(/O2 /Oi /Ot /GL /W4 /permissive-)
else()
    add_compile_options(-O3 -march=native -Wall -Wextra -Wpedantic -fno-omit-frame-pointer)
endif()

include_directories(include)

# Main Library
add_library(matching_engine_core STATIC
    src/order_book.cpp
    src/matching_engine.cpp
)

# Main Executable Server
add_executable(matching_engine_server src/main.cpp)
target_link_libraries(matching_engine_server PRIVATE matching_engine_core)

# Unit Test Runner
add_executable(engine_unit_tests tests/test_order_book.cpp src/order_book.cpp)

# Microsecond Benchmark
add_executable(engine_benchmark benchmarks/benchmark_throughput.cpp src/order_book.cpp)
