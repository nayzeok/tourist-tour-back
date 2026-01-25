import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { RedisService } from '~/redis/redis.service'
import { OAuthService } from '~/services/oauth.service'
import { ImageProxyService } from '~/app/image-proxy/image-proxy.service'
import { TLPropertyContent } from '~/shared'

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name)
  private isSyncing = false

  constructor(
    private readonly redis: RedisService,
    private readonly oauth: OAuthService,
    private readonly imageProxy: ImageProxyService,
  ) {}

  /**
   * Ночная синхронизация контента - запускается в 3:00 по серверному времени
   */
  @Cron('0 3 * * *') // Каждый день в 03:00
  async handleNightlySync() {
    if (this.isSyncing) {
      this.logger.warn('Sync already in progress, skipping...')
      return
    }

    this.isSyncing = true
    this.logger.log('=== Starting nightly content sync ===')

    const startTime = Date.now()

    try {
      // 1. Синхронизируем список городов
      await this.syncCities()

      // 2. Синхронизируем отели по всем закэшированным городам
      await this.syncHotelsContent()

      const duration = Math.round((Date.now() - startTime) / 1000)
      this.logger.log(`=== Nightly sync completed in ${duration}s ===`)
    } catch (error) {
      this.logger.error('Nightly sync failed:', error)
    } finally {
      this.isSyncing = false
    }
  }

  /**
   * Синхронизация списка городов
   */
  private async syncCities() {
    this.logger.log('Syncing cities list...')

    try {
      const [rusCities, gbrCities] = await Promise.all([
        this.oauth.get<{ cities: any[] }>(
          'https://partner.qatl.ru/api/geo/v1/countries/RUS/cities',
        ),
        this.oauth.get<{ cities: any[] }>(
          'https://partner.qatl.ru/api/geo/v1/countries/GBR/cities',
        ),
      ])

      const allCities = [
        ...(rusCities?.cities ?? []),
        ...(gbrCities?.cities ?? []),
      ]

      await this.redis.setJson('geo:cities', { cities: allCities }, 86400)
      this.logger.log(`Synced ${allCities.length} cities`)
    } catch (error) {
      this.logger.error('Failed to sync cities:', error)
    }
  }

  /**
   * Синхронизация контента отелей
   */
  private async syncHotelsContent() {
    this.logger.log('Syncing hotels content...')

    // Получаем список всех закэшированных отелей из Redis
    const hotelKeys = await this.getHotelKeys()
    this.logger.log(`Found ${hotelKeys.length} cached hotels to sync`)

    if (hotelKeys.length === 0) {
      return
    }

    let successCount = 0
    let errorCount = 0
    const PARALLEL = 5 // Параллельность запросов

    for (let i = 0; i < hotelKeys.length; i += PARALLEL) {
      const batch = hotelKeys.slice(i, i + PARALLEL)

      const results = await Promise.allSettled(
        batch.map((key) => this.syncHotelContent(key)),
      )

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          successCount++
        } else {
          errorCount++
        }
      }

      // Небольшая пауза между батчами чтобы не нагружать API
      if (i + PARALLEL < hotelKeys.length) {
        await this.sleep(500)
      }
    }

    this.logger.log(
      `Hotels sync completed: ${successCount} success, ${errorCount} errors`,
    )
  }

  /**
   * Синхронизация контента одного отеля
   */
  private async syncHotelContent(cacheKey: string): Promise<boolean> {
    const hotelId = cacheKey.replace('hotel:', '')

    try {
      // Загружаем свежий контент
      const url = `https://partner.qatl.ru/api/content/v1/properties/${hotelId}`
      const content = await this.oauth.get<TLPropertyContent>(url)

      if (!content) {
        return false
      }

      // Сохраняем в кэш на 24 часа
      await this.redis.setJson(cacheKey, content, 86400)

      // Предзагружаем изображения
      await this.preloadImages(content)

      return true
    } catch (error) {
      this.logger.debug(`Failed to sync hotel ${hotelId}:`, error)
      return false
    }
  }

  /**
   * Предзагрузка изображений отеля
   */
  private async preloadImages(content: TLPropertyContent) {
    const imageUrls: string[] = []

    // Собираем все URL изображений
    if (content.images) {
      imageUrls.push(...content.images.map((img) => img.url))
    }

    if (content.roomTypes) {
      for (const roomType of content.roomTypes) {
        if (roomType.images) {
          imageUrls.push(...roomType.images.map((img) => img.url))
        }
      }
    }

    // Загружаем первые 10 изображений (остальные загрузятся по запросу)
    const toPreload = imageUrls.slice(0, 10)

    for (const url of toPreload) {
      try {
        const encodedUrl = this.imageProxy.encodeUrl(url)
        await this.imageProxy.getImageByEncodedUrl(encodedUrl)
      } catch {
        // Игнорируем ошибки загрузки отдельных изображений
      }
    }
  }

  /**
   * Получает все ключи отелей из Redis
   */
  private async getHotelKeys(): Promise<string[]> {
    const client = this.redis.getClient()
    const keys: string[] = []

    let cursor = '0'
    do {
      const [nextCursor, batch] = await client.scan(
        cursor,
        'MATCH',
        'hotel:*',
        'COUNT',
        100,
      )
      cursor = nextCursor
      keys.push(...batch)
    } while (cursor !== '0')

    return keys
  }

  /**
   * Ручной запуск синхронизации (для тестирования)
   */
  async manualSync() {
    this.logger.log('Manual sync triggered')
    await this.handleNightlySync()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
