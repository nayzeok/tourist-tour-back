export type GuestCount = { adultCount: number; childAges?: number[] }

// ----- Content API -----

export type TLPropertyContent = {
  id: string
  name: string
  images?: { url: string }[]
  stars?: number
  currency?: string
  multiLocationProperty?: boolean
  contactInfo?: {
    address?: {
      addressLine?: string
      cityName?: string
      latitude?: number
      longitude?: number
    }
  }
  policy?: {
    checkInTime?: string // "14:00"
    checkOutTime?: string // "12:00"
  }
  timeZone?: {
    id?: string // "Europe/London"
  }
  amenities?: { code: string; displayName?: string }[]
  roomTypes?: Array<{
    id: string
    name?: string
    images?: { url: string }[]
    address?: { addressLine?: string; cityName?: string }
    amenities?: { code: string }[]
  }>
}

// ----- Search API: room-stay -----

export type TLRoomStay = {
  propertyId: string
  availability?: number
  currencyCode?: string
  checksum?: string | null
  total: { priceBeforeTax?: number; priceAfterTax?: number }
  cancellationPolicy?: {
    freeCancellationPossible?: boolean
    freeCancellationDeadlineLocal?: string | null
    freeCancellationDeadlineUtc?: string | null
    penaltyAmount?: number | null
  }
  paymentPolicy?: { type?: 'OnSite' | 'Prepay' | 'Guarantee' }
  paymentType?: 'OnSite' | 'Prepay' // иногда так
  mealPlanCode?: string | null
  includedServices?: { id?: number; mealPlanCode?: string | null }[]
  ratePlan?: { id: string; corporateIds?: unknown }
  roomType?: {
    id: string
    name?: string
    images?: { url: string }[]
    address?: { addressLine?: string; cityName?: string }
    placements?: Array<{ kind?: string; code?: string; count: number }>
    /** Описание основных и дополнительных мест (зависит от тарифа) */
    fullPlacementsName?: string | null
  }
  /** Описание основных и дополнительных мест (может приходить на уровне room-stay) */
  fullPlacementsName?: string | null
}

// ----- DTO для карточек «офферов» -----

export type RoomOffer = {
  roomTypeId: string
  roomTypeName: string
  /** Количество основных и дополнительных мест (по fullPlacementsName, может отличаться по тарифу) */
  fullPlacementsName?: string | null
  mealLabel: string | null
  paymentType?: 'OnSite' | 'Prepay' | 'Guarantee'
  price: { total: number; perNight: number; currency: string }
  images: string[]
  addressLine?: string
  ratePlanId?: string
  amenities?: string[] // коды удобств именно roomType
  availability?: number // остаток по офферу
  /** Checksum из Search API — нужен для verify/create бронирования */
  checksum?: string
  /** Placement-коды из Search API (AdultBed-1 и т.д.) */
  placements?: Array<{ kind?: string; code?: string; count: number }>
  /** Непрозрачное поле из Search API — требуется для verify/create */
  body?: unknown
  /** Даты/время из Search API — используем для verify/create без дополнительного hydrate */
  stayDates?: {
    arrivalDateTime?: string
    departureDateTime?: string
  }
  // Политика отмены (полная информация)
  cancellationPolicy: {
    freeCancellationPossible: boolean
    freeCancellationDeadlineLocal?: string | null
    freeCancellationDeadlineUtc?: string | null
    penaltyAmount?: number | null
    penaltyCurrency?: string
  }
}

// ----- Полный ответ для страницы отеля -----

export type PropertyOffersResponse = {
  property: {
    id: string
    name: string
    address: string
    stars?: number
    coordinates?: { lat?: number; lon?: number }
    thumbnail?: string | null
    amenities?: string[] // «популярные» для шапки (иконки)
  }
  nights: number
  guests: GuestCount
  currency: string
  minPrice?: number // минимальная цена / ночь среди offers
  offers: RoomOffer[] // все доступные варианты на даты
  checkInTime?: string // "14:00" — дефолтное время заезда отеля
  checkOutTime?: string // "12:00" — дефолтное время выезда отеля
}

export type TLPropertyBrief = { id: string }
export type TLGeoPropsResp = {
  properties: TLPropertyBrief[]
  next?: string | null
}

export type TLSearchAggResp = { roomStays: TLRoomStay[]; warnings?: any[] }

export type HotelCard = {
  id: string
  name: string
  address: string
  coordinates?: { lat?: number; lon?: number }
  stars?: number
  thumbnail?: string[]
  amenities?: string[] // коды (для иконок)
  // из Search (минимальный вариант)
  roomName: string
  mealLabel?: string | null
  payOnSite: boolean
  price: { value: number; currency: string; per: 'night' | 'stay' }
  guestsNote: string // "за ночь для 3 гостей"
  checkInTime?: string // "14:00"
  checkOutTime?: string // "12:00"
  timeZone?: string // "Europe/London"
  // Политика отмены (полная информация)
  cancellationPolicy: {
    freeCancellationPossible: boolean // возможна ли бесплатная отмена
    freeCancellationDeadlineLocal?: string | null // дедлайн в локальном времени отеля "2025-08-19T17:41"
    freeCancellationDeadlineUtc?: string | null // дедлайн в UTC "2025-08-19T14:41Z"
    penaltyAmount?: number | null // размер штрафа
    penaltyCurrency?: string // валюта штрафа (RUB, USD, etc.)
  }
}
