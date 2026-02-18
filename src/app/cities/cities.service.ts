import { Injectable } from '@nestjs/common'
import { DbService } from '~/db/db.service'
import { RedisService } from '~/redis/redis.service'
import { OAuthService } from '~/services/oauth.service'
import { ConfigService } from '@nestjs/config'

@Injectable()
export class CitiesService {
  private readonly tlBase = (process.env.TL_BASE || 'https://partner.qatl.ru').replace(/\/$/, '')

  constructor(
    private readonly db: DbService,
    private readonly redisService: RedisService,
    private readonly oauthService: OAuthService,
    private readonly configService: ConfigService,
  ) {}

  async getGeoData() {
    const cities = await this.redisService.getJson('geo:cities')

    if (cities) {
      return {
        success: true,
        data: cities,
        cached: true,
        timestamp: new Date().toISOString(),
      }
    } else {
      try {
        // Используем OAuthService для авторизованных запросов
        const cities = await Promise.all([
          this.oauthService.get(
            `${this.tlBase}/api/geo/v1/countries/RUS/cities`,
          ),
          this.oauthService.get(
            `${this.tlBase}/api/geo/v1/countries/GBR/cities`,
          ),
        ])

        const geoData = cities.reduce((prev, curr) => {
          const s = curr.cities

          return [...prev, ...s]
        }, [])

        const d = { cities: geoData }

        // Кэшируем результат в Redis на 24 часа (86400 секунд)
        await this.redisService.setJson('geo:cities', d, 86400)

        return {
          success: true,
          data: d,
          cached: false,
          timestamp: new Date().toISOString(),
        }
      } catch (error) {
        // Пытаемся получить из кэша если API недоступен
        const cachedData = await this.redisService.getJson('geo:cities')

        if (cachedData) {
          return {
            success: true,
            data: cachedData,
            cached: true,
            timestamp: new Date().toISOString(),
          }
        }

        throw error
      }
    }
  }

  async postExampleData(payload: any) {
    // Пример POST запроса через OAuth
    const result = await this.oauthService.post(
      `${this.tlBase}/api/some-endpoint`,
      payload,
    )

    return {
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    }
  }
}
