# Multi-stage production build for C++20 Low-Latency Matching Engine
FROM ubuntu:24.04 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    clang-18 \
    ninja-build \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=clang++-18
RUN cmake --build build --target matching_engine_server engine_unit_tests engine_benchmark

# Run unit tests during build
RUN ./build/engine_unit_tests

FROM ubuntu:24.04 AS runner
WORKDIR /app
COPY --from=builder /app/build/matching_engine_server .
COPY --from=builder /app/build/engine_benchmark .

EXPOSE 8080 9001
CMD ["./matching_engine_server"]
