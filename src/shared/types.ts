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
  }
}

// ----- DTO для карточек «офферов» -----

export type RoomOffer = {
  roomTypeId: string
  roomTypeName: string
  mealLabel: string | null
  freeCancel: boolean | string
  paymentType?: 'OnSite' | 'Prepay' | 'Guarantee'
  price: { total: number; perNight: number; currency: string }
  images: string[]
  addressLine?: string
  ratePlanId?: string
  amenities?: string[] // коды удобств именно roomType
  availability?: number // остаток по офферу
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
  freeCancel: boolean | string // true | "до 12.10.2025" | false
  payOnSite: boolean
  price: { value: number; currency: string; per: 'night' | 'stay' }
  guestsNote: string // "за ночь для 3 гостей"
}
