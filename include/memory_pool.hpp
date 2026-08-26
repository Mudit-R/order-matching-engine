#pragma once

#include <vector>
#include <memory>
#include <cassert>
#include <cstddef>
#include "types.hpp"

namespace Engine {

/**
 * @brief Zero-allocation, cache-friendly Object Pool Allocator.
 * Eliminates heap allocation latency (malloc/free) in the critical matching path.
 */
template <typename T, size_t BlockSize = 65536>
class ObjectPool {
public:
    ObjectPool() {
        allocateBlock();
    }

    ~ObjectPool() = default;

    // Non-copyable, non-movable for safety
    ObjectPool(const ObjectPool&) = delete;
    ObjectPool& operator=(const ObjectPool&) = delete;

    template <typename... Args>
    T* acquire(Args&&... args) {
        if (free_list_ == nullptr) {
            allocateBlock();
        }
        Node* node = free_list_;
        free_list_ = free_list_->next;
        
        T* obj = reinterpret_cast<T*>(&node->storage);
        new (obj) T(std::forward<Args>(args)...);
        return obj;
    }

    void release(T* obj) {
        if (obj == nullptr) return;
        obj->~T();
        Node* node = reinterpret_cast<Node*>(obj);
        node->next = free_list_;
        free_list_ = node;
    }

private:
    union Node {
        alignas(alignof(T)) std::byte storage[sizeof(T)];
        Node* next;
    };

    struct Block {
        std::unique_ptr<Node[]> memory;
        explicit Block(size_t size) : memory(std::make_unique<Node[]>(size)) {}
    };

    void allocateBlock() {
        blocks_.emplace_back(std::make_unique<Block>(BlockSize));
        Block* current_block = blocks_.back().get();
        for (size_t i = 0; i < BlockSize - 1; ++i) {
            current_block->memory[i].next = &current_block->memory[i + 1];
        }
        current_block->memory[BlockSize - 1].next = free_list_;
        free_list_ = &current_block->memory[0];
    }

    std::vector<std::unique_ptr<Block>> blocks_;
    Node* free_list_{nullptr};
};

} // namespace Engine
