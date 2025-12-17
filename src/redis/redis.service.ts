import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'

@Injectable()
export class RedisService implements OnModuleDestroy {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  onModuleDestroy() {
    this.redis.disconnect()
  }

  // Базовые операции
  async get(key: string): Promise<string | null> {
    return await this.redis.get(key)
  }

  async set(key: string, value: string, ttl?: number): Promise<'OK'> {
    if (ttl) {
      return await this.redis.setex(key, ttl, value)
    }
    return await this.redis.set(key, value)
  }

  async del(key: string): Promise<number> {
    return await this.redis.del(key)
  }

  async exists(key: string): Promise<number> {
    return await this.redis.exists(key)
  }

  async expire(key: string, seconds: number): Promise<number> {
    return await this.redis.expire(key, seconds)
  }

  async ttl(key: string): Promise<number> {
    return await this.redis.ttl(key)
  }

  // JSON операции
  async setJson(key: string, value: any, ttl?: number): Promise<'OK'> {
    const jsonValue = JSON.stringify(value)
    return await this.set(key, jsonValue, ttl)
  }

  async getJson<T = any>(key: string): Promise<T | null> {
    const value = await this.get(key)
    if (!value) return null
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }

  // Hash операции
  async hset(key: string, field: string, value: string): Promise<number> {
    return await this.redis.hset(key, field, value)
  }

  async hget(key: string, field: string): Promise<string | null> {
    return await this.redis.hget(key, field)
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return await this.redis.hgetall(key)
  }

  async hdel(key: string, field: string): Promise<number> {
    return await this.redis.hdel(key, field)
  }

  // Операции со списками
  async lpush(key: string, ...values: string[]): Promise<number> {
    return await this.redis.lpush(key, ...values)
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    return await this.redis.rpush(key, ...values)
  }

  async lpop(key: string): Promise<string | null> {
    return await this.redis.lpop(key)
  }

  async rpop(key: string): Promise<string | null> {
    return await this.redis.rpop(key)
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return await this.redis.lrange(key, start, stop)
  }

  // Доступ к оригинальному клиенту для расширенных операций
  getClient(): Redis {
    return this.redis
  }
}
