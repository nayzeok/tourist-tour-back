import { registerAs } from '@nestjs/config'
import { RedisOptions } from 'ioredis'

export default registerAs('redis', (): RedisOptions => {
  const host = process.env.REDIS_HOST || 'localhost'
  const port = parseInt(process.env.REDIS_PORT || '6379', 10)
  const password = process.env.REDIS_PASSWORD

  return {
    host,
    port,
    password,
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    keepAlive: 30000,
    family: 4,
    connectTimeout: 10000,
    commandTimeout: 5000,
    enableOfflineQueue: true,
  }
})
