#pragma once

#include <atomic>
#include <cstddef>
#include <new>
#include <utility>
#include <vector>
#include <cassert>

namespace Engine {

#if defined(__cpp_lib_hardware_interference_size)
    using std::hardware_destructive_interference_size;
#else
    // 64 bytes is standard cache line size for modern x86/ARM processors
    constexpr size_t hardware_destructive_interference_size = 64;
#endif

/**
 * @brief Lock-Free Single-Producer Single-Consumer (SPSC) Queue.
 * Employs cache-line separation and std::memory_order acquire-release semantics
 * to eliminate mutex locking overhead and false sharing in inter-thread communication.
 */
template <typename T, size_t Capacity = 1048576> // Default 1M power-of-2 capacity
class LockFreeRingBuffer {
    static_assert((Capacity & (Capacity - 1)) == 0, "Capacity must be a power of 2 for fast bitmask indexing");

public:
    LockFreeRingBuffer() {
        buffer_ = static_cast<Node*>(::operator new(sizeof(Node) * Capacity));
    }

    ~LockFreeRingBuffer() {
        T item;
        while (pop(item)) {
            // Drain remaining items and destruct them
        }
        ::operator delete(buffer_);
    }

    LockFreeRingBuffer(const LockFreeRingBuffer&) = delete;
    LockFreeRingBuffer& operator=(const LockFreeRingBuffer&) = delete;

    /**
     * @brief Producer push (non-blocking).
     * Returns true if successfully pushed, false if buffer is full.
     */
    template <typename... Args>
    bool emplace(Args&&... args) {
        const size_t current_tail = tail_.load(std::memory_order_relaxed);
        const size_t current_head = head_cached_;

        if (current_tail - current_head >= Capacity) {
            // Cache miss: reload real head with acquire semantics
            head_cached_ = head_.load(std::memory_order_acquire);
            if (current_tail - head_cached_ >= Capacity) {
                return false; // Queue is genuinely full
            }
        }

        Node* node = &buffer_[current_tail & BufferMask];
        new (&node->storage) T(std::forward<Args>(args)...);

        tail_.store(current_tail + 1, std::memory_order_release);
        return true;
    }

    bool push(const T& item) {
        return emplace(item);
    }

    bool push(T&& item) {
        return emplace(std::move(item));
    }

    /**
     * @brief Consumer pop (non-blocking).
     * Returns true if item popped, false if buffer is empty.
     */
    bool pop(T& val) {
        const size_t current_head = head_.load(std::memory_order_relaxed);
        const size_t current_tail = tail_cached_;

        if (current_head == current_tail) {
            // Cache miss: reload real tail with acquire semantics
            tail_cached_ = tail_.load(std::memory_order_acquire);
            if (current_head == tail_cached_) {
                return false; // Queue is genuinely empty
            }
        }

        Node* node = &buffer_[current_head & BufferMask];
        T* obj = reinterpret_cast<T*>(&node->storage);
        val = std::move(*obj);
        obj->~T();

        head_.store(current_head + 1, std::memory_order_release);
        return true;
    }

    [[nodiscard]] bool empty() const noexcept {
        return head_.load(std::memory_order_relaxed) == tail_.load(std::memory_order_relaxed);
    }

    [[nodiscard]] size_t size() const noexcept {
        const size_t head = head_.load(std::memory_order_relaxed);
        const size_t tail = tail_.load(std::memory_order_relaxed);
        return (tail >= head) ? (tail - head) : 0;
    }

private:
    static constexpr size_t BufferMask = Capacity - 1;

    struct Node {
        alignas(alignof(T)) std::byte storage[sizeof(T)];
    };

    Node* buffer_{nullptr};

    // Prevent false sharing by placing producer and consumer indices on separate cache lines
    alignas(hardware_destructive_interference_size) std::atomic<size_t> tail_{0};
    alignas(hardware_destructive_interference_size) size_t head_cached_{0};

    alignas(hardware_destructive_interference_size) std::atomic<size_t> head_{0};
    alignas(hardware_destructive_interference_size) size_t tail_cached_{0};
};

} // namespace Engine
