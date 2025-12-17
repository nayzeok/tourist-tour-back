// hotel.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { AxiosError } from 'axios'
import { OAuthService } from '~/services/oauth.service'
import { RedisService } from '~/redis/redis.service'
import {
  GuestCount,
  HotelCard,
  TLGeoPropsResp,
  TLPropertyContent,
  TLRoomStay,
  TLSearchAggResp,
} from '~/shared'
import { formatRuDate } from '~/utils/date'

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name)

  constructor(
    private readonly oauthService: OAuthService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Главный метод: список карточек для города
   */
  async getHotelsList(
    cityId: string,
    arrival: string, // "YYYY-MM-DD"
    departure: string, // "YYYY-MM-DD"
    guests: GuestCount, // { adultCount, childAges? }
    opts?: {
      currency?: string
      limit?: number
      offset?: number
    },
  ) {
    const currency = opts?.currency ?? 'RUB'

    // 1) propertyIds по городу
    const ids = await this.getPropertyIdsByCity(cityId)

    // console.log('ids', ids)

    if (!ids.length) return []

    // пагинация на нашей стороне (если надо)
    const start = opts?.offset ?? 0
    const end = opts?.limit ? start + opts.limit : ids.length
    const sliced = ids.slice(start, end)

    // 2) Контент: подтащим из кэша/догрузим что отсутствует
    const contentById = await this.getContentForIds(sliced)

    // 3) Search (агрегатор): возьмём минимальные варианты по пачкам
    const cheapestById = await this.getCheapestByPropertyIds(
      sliced,
      arrival,
      departure,
      guests,
      currency,
    )

    // console.log(JSON.stringify(Object.fromEntries(contentById), null, 2))

    // 4) Склейка → карточки
    const nights = this.diffNights(arrival, departure)
    const cards: HotelCard[] = []
    for (const id of sliced) {
      const content = contentById.get(id)
      const offer = cheapestById.get(id)
      if (!content || !offer) {
        // нет подходящих вариантов на даты — пропускаем
        continue
      }

      cards.push(this.buildCard(content, offer, nights, guests))
      // console.log('content', JSON.stringify(content, null, 2))
    }

    // 5) Сортировка по цене
    cards.sort((a, b) => a.price.value - b.price.value)

    return cards
  }

  async getPropertyContent(
    id: string,
    opts?: { refresh?: boolean },
  ): Promise<{ cached: boolean; data: TLPropertyContent; stale?: boolean }> {
    const cacheKey = this.contentCacheKey(id)
    const cached = await this.redis.getJson<TLPropertyContent>(cacheKey)

    if (cached && !opts?.refresh) {
      return { cached: true, data: cached }
    }

    const fresh = await this.fetchAndCacheContent(id)

    if (fresh) {
      return { cached: false, data: fresh }
    }

    if (cached) {
      return { cached: true, data: cached, stale: true }
    }

    throw new NotFoundException(`Property ${id} content not available`)
  }

  // ---------- GEO ----------

  private async getPropertyIdsByCity(cityId: string): Promise<string[]> {
    // Берём всё за один вызов (tall иногда поддерживает пагинацию через next/offset)
    const url = `https://partner.qatl.ru/api/geo/v1/cities/${cityId}/properties`
    const resp = await this.oauthService.get<TLGeoPropsResp>(url)

    return (resp?.properties ?? []).map((p) => p.id)
  }

  // ---------- CONTENT + CACHE ----------

  private contentCacheKey(id: string): string {
    return `hotel:${id}`
  }

  private async getContentForIds(
    ids: string[],
  ): Promise<Map<string, TLPropertyContent>> {
    const result = new Map<string, TLPropertyContent>()
    const misses: string[] = []

    // пробуем из кэша
    for (const id of ids) {
      const cacheKey = this.contentCacheKey(id)
      const cached = await this.redis.getJson<TLPropertyContent>(cacheKey)

      if (cached) {
        result.set(id, cached)
      } else {
        misses.push(id)
      }
    }

    // дозакачка пропусков с ограничением параллелизма
    const PARALLEL = 10

    for (let i = 0; i < misses.length; i += PARALLEL) {
      const chunk = misses.slice(i, i + PARALLEL)
      const reqs = chunk.map((pid) => this.fetchAndCacheContent(pid))
      const loaded = await Promise.all(reqs)

      loaded.forEach((c, idx) => c && result.set(chunk[idx], c))
    }

    return result
  }

  private async fetchAndCacheContent(
    id: string,
  ): Promise<TLPropertyContent | null> {
    try {
      const url = `https://partner.qatl.ru/api/content/v1/properties/${id}`
      const data = await this.oauthService.get<TLPropertyContent>(url)
      // пишем в кэш на сутки
      const cacheKey = this.contentCacheKey(id)
      await this.redis.setJson(cacheKey, data, 86400)

      return data
    } catch (e) {
      const err = e as AxiosError
      const detail = err.response?.data
      let detailStr: string | undefined
      if (typeof detail === 'string') {
        detailStr = detail
      } else if (detail) {
        try {
          detailStr = JSON.stringify(detail)
        } catch {
          detailStr = '[unserializable detail]'
        }
      }
      const message = err.message || String(e)
      const formatted =
        `content ${id} failed: ${message}` +
        (detailStr ? ` | detail: ${detailStr}` : '')
      this.logger.warn(formatted)
      return null
    }
  }

  // ---------- SEARCH (AGGREGATOR) ----------

  private async getCheapestByPropertyIds(
    ids: string[],
    arrival: string,
    departure: string,
    guests: GuestCount,
    currency: string,
  ): Promise<Map<string, TLRoomStay>> {
    const out = new Map<string, TLRoomStay>()
    const CHUNK = 200 // сколько id отправлять за один вызов аггрегатора

    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK)
      const body = {
        propertyIds: batch,
        adults: guests.adultCount,
        arrivalDate: arrival,
        departureDate: departure,
        pricePreference: {
          currencyCode: currency,
          minPrice: 0,
          maxPrice: 100000,
        },
        // тут можно добавить mealPreference/pricePreference/filters
      }

      // console.log(JSON.stringify(body, null, 2))

      const resp = await this.oauthService.post<TLSearchAggResp>(
        'https://partner.qatl.ru/api/search/v1/properties/room-stays/search',
        body,
      )

      const list = resp?.roomStays ?? []

      // группируем по propertyId и берём самый дешёвый
      for (const rs of list) {
        const total = this.rsTotal(rs)
        const cur = out.get(rs.propertyId)
        const curTotal = cur ? this.rsTotal(cur) : Number.POSITIVE_INFINITY

        if (!cur || total < curTotal) out.set(rs.propertyId, rs)
      }
    }

    return out
  }

  // ---------- MAPPING ----------
  private buildCard(
    content: TLPropertyContent,
    rs: TLRoomStay,
    nights: number,
    guests: GuestCount,
  ): HotelCard {
    const priceTotal = this.rsTotal(rs)
    const perNight = Math.max(1, Math.round(priceTotal / Math.max(1, nights)))
    const currency = rs.currencyCode || content.currency || 'RUB'

    // 1) сопоставляем roomType из контента по id
    const rtFromContent = content.roomTypes?.find(
      (rt) => String(rt.id) === String(rs.roomType?.id),
    )

    // 2) адрес (для мульти-локации — из roomType в приоритете)
    const addr =
      content.multiLocationProperty &&
      (rs.roomType?.address || rtFromContent?.address)
        ? [
            rs.roomType?.address?.addressLine ??
              rtFromContent?.address?.addressLine,
            rs.roomType?.address?.cityName ?? rtFromContent?.address?.cityName,
          ]
            .filter(Boolean)
            .join(', ')
        : [
            content.contactInfo?.address?.addressLine,
            content.contactInfo?.address?.cityName,
          ]
            .filter(Boolean)
            .join(', ')

    // 3) фотки: roomType (если есть) → иначе фотки объекта
    const thumbImages =
      (rtFromContent?.images?.length
        ? rtFromContent.images
        : rs.roomType?.images?.length
          ? rs.roomType.images
          : content.images) ?? []
    const thumbnail = thumbImages.map((i) => i.url)

    // 4) питание/отмена/оплата — как было
    const mealCode =
      rs.mealPlanCode ||
      rs.includedServices?.find((s) => s.mealPlanCode)?.mealPlanCode ||
      undefined
    const mealLabel = mealCode ? this.mealLabel(mealCode) : null

    const freeCancel = rs.cancellationPolicy?.freeCancellationPossible
      ? rs.cancellationPolicy.freeCancellationDeadlineLocal
        ? `до ${formatRuDate(rs.cancellationPolicy.freeCancellationDeadlineLocal)}`
        : true
      : false

    // console.log(JSON.stringify(rs, null, 2))

    const payOnSite =
      rs.paymentPolicy?.type === 'OnSite' || rs.paymentType === 'OnSite'

    const guestsTotal = guests.adultCount + (guests.childAges?.length ?? 0)

    // 5) удобства для карточки списка — оставь объектные (как у тебя),
    //    а комнатные выводим уже на странице отеля в офферах
    const propertyAmenityCodes = (content.amenities ?? []).map((a) => a.code)
    const amenities = [...new Set(propertyAmenityCodes)]

    return {
      id: content.id,
      name: content.name,
      address: addr,
      coordinates: {
        lat: content.contactInfo?.address?.latitude,
        lon: content.contactInfo?.address?.longitude,
      },
      stars: content.stars,
      thumbnail,
      amenities,
      // КЛЮЧЕВОЕ: берём имя комнаты из Search, иначе из Content
      roomName: rs.roomType?.name ?? rtFromContent?.name ?? 'Номер',
      mealLabel,
      freeCancel,
      payOnSite,
      price: { value: perNight, currency, per: 'night' },
      guestsNote: `за ночь для ${guestsTotal} гост${this.ruPlural(guestsTotal, 'я', 'ей')}`,
    }
  }

  // ---------- UTILS ----------

  rsTotal(rs: TLRoomStay): number {
    return (
      rs.total?.priceBeforeTax ??
      rs.total?.priceAfterTax ??
      Number.POSITIVE_INFINITY
    )
  }

  diffNights(a: string, b: string): number {
    const ms = +new Date(b + 'T00:00:00') - +new Date(a + 'T00:00:00')
    return Math.max(1, Math.round(ms / 86400000))
  }

  mealLabel(code: string): string {
    const map: Record<string, string> = {
      AllInclusive: 'Всё включено',
      FullBoard: 'Трёхразовое питание',
      HalfBoard: 'Полупансион',
      Breakfast: 'Завтрак',
      BreakFast: 'Завтрак', // встречается так
      ContinentalBreakfast: 'Континентальный завтрак',
      BuffetDinner: 'Ужин "Шведский стол"',
    }

    return map[code] ?? ''
  }

  private ruPlural(n: number, f1 = '', f2 = 'а', f5 = 'ов') {
    const v = Math.abs(n) % 100
    const v1 = v % 10
    if (v > 10 && v < 20) return f5
    if (v1 > 1 && v1 < 5) return f2
    if (v1 === 1) return f1
    return f5
  }
}
