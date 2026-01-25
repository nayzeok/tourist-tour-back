import { Injectable, Logger } from '@nestjs/common'
import {
  GuestCount,
  PropertyOffersResponse,
  RoomOffer,
  TLPropertyContent,
  TLRoomStay,
} from '~/shared'
import { SearchService } from '~/app/search/search.service'
import { OAuthService } from '~/services'
import { ImageProxyService } from '~/app/image-proxy/image-proxy.service'
import { RedisService } from '~/redis/redis.service'
import { formatRuDate } from '~/utils/date'

@Injectable()
export class OfferService {
  private readonly logger = new Logger(OfferService.name)
  
  // In-flight запросы для дедупликации одновременных вызовов
  private readonly inFlightRequests = new Map<string, Promise<{ roomStays: TLRoomStay[] }>>()

  constructor(
    private readonly search: SearchService,
    private readonly oauth: OAuthService,
    private readonly imageProxy: ImageProxyService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Страница отеля: все доступные предложения на даты.
   * Возвращает «шапку» отеля + массив офферов (варианты одноместный/двухместный, с завтраком/без и т.д.).
   */
  async getPropertyOffers(
    propertyId: string,
    arrival: string, // YYYY-MM-DD
    departure: string, // YYYY-MM-DD
    guests: GuestCount,
    opts?: { currency?: string; language?: string },
  ): Promise<PropertyOffersResponse> {
    const currency = opts?.currency ?? 'RUB'

    // 1) Контент объекта: фото, звёзды, адрес, amenities по property и по roomType
    const { data: content } = await this.search.getPropertyContent(propertyId)

    // 2) Поиск всех офферов по одному объекту с кэшированием и дедупликацией
    const roomStays = await this.getRoomStaysWithDedup(
      propertyId,
      arrival,
      departure,
      guests,
      currency,
    )

    const nights = this.search.diffNights(arrival, departure)

    // 3) Маппинг всех офферов
    const offers: RoomOffer[] = roomStays.map((rs) =>
      this.mapRoomStayToOffer(content, rs, nights),
    )

    // 4) Минимальная цена / ночь среди офферов (для шапки)
    const minPerNight = offers.length
      ? Math.min(...offers.map((o) => o.price.perNight))
      : undefined

    // 5) «Шапка» отеля
    const address = [
      content.contactInfo?.address?.addressLine,
      content.contactInfo?.address?.cityName,
    ]
      .filter(Boolean)
      .join(', ')

    const rawThumbnail =
      content.images?.[0]?.url ??
      roomStays[0]?.roomType?.images?.[0]?.url ??
      null
    // Трансформируем URL через наш прокси
    const thumbnail = rawThumbnail
      ? this.imageProxy.transformUrl(rawThumbnail)
      : null

    // «Популярные» удобства объекта (короткий набор для иконок)
    const popularAmenityCodes = content.amenities

    // console.log(JSON.stringify(popularAmenityCodes, null, 2))

    return {
      property: {
        id: content.id,
        name: content.name,
        address,
        stars: content.stars,
        coordinates: {
          lat: content.contactInfo?.address?.latitude,
          lon: content.contactInfo?.address?.longitude,
        },
        thumbnail,
        amenities: popularAmenityCodes as unknown as any,
      },
      nights,
      guests,
      currency,
      minPrice: minPerNight,
      offers,
    }
  }

  /**
   * Маппинг одного оффера (roomStay) в DTO для фронта.
   * Здесь же подмешиваем картинки/удобства roomType из Content API.
   */
  private mapRoomStayToOffer(
    content: TLPropertyContent,
    rs: TLRoomStay,
    nights: number,
  ): RoomOffer {
    // roomType из контента (ради имени, картинок и amenities конкретного типа)
    const rt = content.roomTypes?.find((rt) => rt.id === rs.roomType?.id)

    // питание
    const mealCode =
      rs.mealPlanCode ||
      rs.includedServices?.find((s) => s.mealPlanCode)?.mealPlanCode ||
      undefined
    const mealLabel = mealCode ? this.search.mealLabel(mealCode) : null

    // Политика отмены - передаём полную информацию
    const currency = rs.currencyCode || content.currency || 'RUB'
    const cancellationPolicy = {
      freeCancellationPossible: rs.cancellationPolicy?.freeCancellationPossible ?? false,
      freeCancellationDeadlineLocal: rs.cancellationPolicy?.freeCancellationDeadlineLocal ?? null,
      freeCancellationDeadlineUtc: rs.cancellationPolicy?.freeCancellationDeadlineUtc ?? null,
      penaltyAmount: rs.cancellationPolicy?.penaltyAmount ?? null,
      penaltyCurrency: currency,
    }

    // оплата
    const paymentType = rs.paymentPolicy?.type ?? rs.paymentType

    // цены
    const total = this.search.rsTotal(rs)
    const perNight = Math.max(1, Math.round(total / Math.max(1, nights)))

    // картинки приоритезируем из контента (они обычно лучше и стабильнее)
    // Трансформируем URL через наш прокси
    const images = this.imageProxy.transformUrls(
      (rt?.images?.length ? rt.images : (rs.roomType?.images ?? [])).map(
        (i) => i.url,
      ),
    )

    // удобства именно roomType (для блока «Услуги и удобства» у карточки номера)
    const roomAmenities = rt?.amenities ?? []

    return {
      roomTypeId: rs.roomType?.id ?? rt?.id ?? '',
      roomTypeName: rs.roomType?.name ?? rt?.name ?? 'Номер',
      mealLabel,
      paymentType,
      price: { total, perNight, currency },
      images,
      addressLine:
        rs.roomType?.address?.addressLine ?? rt?.address?.addressLine,
      ratePlanId: (rs as any)?.ratePlan?.id,
      amenities: roomAmenities as unknown as any, // <— коды удобств именно этого типа номера
      availability: rs.availability, // <— остаток по офферу (удобно для бейджей «остался 1 номер»)
      cancellationPolicy,
    }
  }

  /**
   * Получение room-stays с дедупликацией одновременных запросов и кратковременным кэшированием.
   * Предотвращает дублирующие запросы к TravelLine API.
   */
  private async getRoomStaysWithDedup(
    propertyId: string,
    arrival: string,
    departure: string,
    guests: GuestCount,
    currency: string,
  ): Promise<TLRoomStay[]> {
    // Формируем уникальный ключ для запроса
    const childAgesStr = (guests.childAges ?? []).sort((a, b) => a - b).join(',')
    const requestKey = `rs:${propertyId}:${arrival}:${departure}:${guests.adultCount}:${childAgesStr}:${currency}`
    
    // Проверяем кратковременный кэш (5 минут) для тех же параметров
    const cacheKey = `search:room-stays:${requestKey}`
    const cached = await this.redis.getJson<TLRoomStay[]>(cacheKey)
    if (cached) {
      this.logger.debug(`Room-stays cache hit: ${propertyId}`)
      return cached
    }

    // Дедупликация: если уже есть запрос в полёте с теми же параметрами, ждём его
    const inFlight = this.inFlightRequests.get(requestKey)
    if (inFlight) {
      this.logger.debug(`Room-stays request deduped: ${propertyId}`)
      const result = await inFlight
      return (result?.roomStays ?? []).filter((rs) => rs.propertyId === propertyId)
    }

    // Создаём новый запрос и регистрируем его как "в полёте"
    const fetchPromise = this.fetchRoomStays(propertyId, arrival, departure, guests, currency)
    this.inFlightRequests.set(requestKey, fetchPromise)

    try {
      const result = await fetchPromise
      const roomStays = (result?.roomStays ?? []).filter((rs) => rs.propertyId === propertyId)
      
      // Кэшируем результат на 5 минут (цены могут меняться)
      await this.redis.setJson(cacheKey, roomStays, 300)
      
      return roomStays
    } finally {
      // Удаляем из in-flight после завершения
      this.inFlightRequests.delete(requestKey)
    }
  }

  /**
   * Непосредственный запрос к TravelLine Search API
   */
  private async fetchRoomStays(
    propertyId: string,
    arrival: string,
    departure: string,
    guests: GuestCount,
    currency: string,
  ): Promise<{ roomStays: TLRoomStay[] }> {
    const params = new URLSearchParams({
      adults: String(guests.adultCount),
      arrivalDate: arrival,
      departureDate: departure,
      currencyCode: currency,
    })
    for (const age of guests.childAges ?? []) {
      params.append('childAges', String(age))
    }

    try {
      return await this.oauth.get<{ roomStays: TLRoomStay[] }>(
        `https://partner.qatl.ru/api/search/v1/properties/${propertyId}/room-stays?${params.toString()}`,
      )
    } catch {
      // Фоллбек на POST — на некоторых стендах метод может быть реализован так
      const body = {
        adults: guests.adultCount,
        childAges: guests.childAges ?? [],
        arrivalDate: arrival,
        departureDate: departure,
        pricePreference: {
          currencyCode: currency,
          minPrice: 0,
          maxPrice: 100000,
        },
      }
      return this.oauth.post<{ roomStays: TLRoomStay[] }>(
        `https://partner.qatl.ru/api/search/v1/properties/${propertyId}/room-stays`,
        body,
      )
    }
  }

  /** Отбор «популярных» удобств для шапки/иконок */
  private pickTopAmenities(am?: { code: string }[]): string[] {
    if (!am?.length) return []
    const white = new Set([
      'wifi',
      'wifi_internet',
      'parking',
      'swimming_pool',
      'beach',
      'spa',
      'air_conditioning',
      'transfer',
      'restaurant',
      'fitness',
    ])
    const codes = am.map((a) => a.code)
    return codes.filter((c) => white.has(c)).slice(0, 6)
  }
}
