import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common'
import { randomUUID } from 'crypto'
import { OAuthService } from '~/services'
import { TLRoomStay } from '~/shared'
import { format } from 'date-fns'
import { AuthService } from '~/app/auth/auth.service'
import { UserService } from '~/app/user/user.service'
import { MailService } from '~/services/mail.service'
import { RedisService } from '~/redis/redis.service'
import axios, { AxiosError } from 'axios'

const PENDING_BOOKING_PREFIX = 'pending-booking:'
const PENDING_BOOKING_TTL_SEC = 60 * 60 // 60 минут (запас на долгую оплату)
const PAYMENT_SUCCESS_PREFIX = 'payment-success:'
const PAYMENT_SUCCESS_TTL_SEC = 60 * 60 // 1 час
const ALT_ROOMSTAY_PREFIX = 'alt-roomstay:'
const ALT_ROOMSTAY_TTL_SEC = 30 * 60 // 30 минут

/**
 * --- Минимальные типы под Reservation API (по твоему OpenAPI) ---
 * Я оставил только то, что реально нужно, остальное можно докинуть по мере надобности.
 */

/** ===== Common ===== */

export type BookingPlacementKind =
  | 'Adult'
  | 'ExtraAdult'
  | 'Child'
  | 'ExtraChild'
  | 'ChildBandWithoutBed'

export type BookingPlacementRq = {
  /** Строка из Search → roomType.placements[i].code, напр. "AdultBed-2", "ChildExtraBed-3-6" */
  code: string
}

export type BookingGuestCount = {
  adultCount: number
  childAges?: number[]
}

export type BookingStayDates = {
  /** "YYYY-MM-DDThh:mm" (ЛОКАЛЬНОЕ время отеля) */
  arrivalDateTime: string
  /** "YYYY-MM-DDThh:mm" (ЛОКАЛЬНОЕ время отеля) */
  departureDateTime: string
}

export type BookingGuest = {
  firstName: string
  lastName: string
  middleName?: string | null
  citizenship?: string | null // alpha-3, напр. "RUS"
  // sex?: 'Male'|'Female'  // если нужно — добавишь
}

export type BookingPersonPhone = { phoneNumber: string }
export type BookingPersonEmail = { emailAddress: string }

export type BookingPersonContacts = {
  phones: BookingPersonPhone[]
  emails: BookingPersonEmail[]
}

export type BookingCustomer = {
  firstName: string
  lastName: string
  middleName?: string | null
  citizenship?: string | null // alpha-3
  contacts: BookingPersonContacts
  comment?: string | null
}

export type BookingRatePlanRq = { id: string }
export type BookingRoomTypeRq = { id: string; placements: BookingPlacementRq[] }

export type BookingRoomStayRq = {
  stayDates: BookingStayDates
  ratePlan: BookingRatePlanRq
  roomType: BookingRoomTypeRq
  guests: BookingGuest[] // по одному на каждого фактического гостя (минимум основной)
  guestCount: BookingGuestCount // структурно (adults + child ages)
  checksum: string // ИЗ Search API
  services?: RoomStayServiceRq[] | null
  extraStay?: ExtraStay | null
  body?: unknown
}

export type RoomStayServiceRq = {
  id: string
  quantity?: number | null
  quantityByGuests?: {
    adultsServiceQuantity?: number
    childrenServiceQuantity?: Array<{ age: number; count: number }> | null
  } | null
}

export type ExtraStay = {
  earlyArrival?: { overriddenDateTime: string } // "YYYY-MM-DDThh:mm"
  lateDeparture?: { overriddenDateTime: string }
}

/** Предоплата (если ты принимаешь деньги у себя/шлёшь сумму) */
export type PaymentType = 'Cash' | 'PrePay'
export type BookingPrepayment = {
  remark?: string | null
  paymentType?: PaymentType
  prepaidSum?: number | null
}

/** ===== Verify/Create ===== */

export type BookingRq = {
  propertyId: string
  roomStays: BookingRoomStayRq[]
  services?: BookingServiceRq[] | null // per-booking services (редко)
  customer: BookingCustomer
  prepayment?: BookingPrepayment | null
  bookingComments?: string[] | null
  corporateId?: string | null
}

export type BookingServiceRq = { id: string }

export type VerifyBookingRequest = { booking: BookingRq }
export type VerifyBookingRs = {
  // нам важно вытащить токен для создания
  createBookingToken: string
  // + в ответе ещё вернут актуальные цены/политики и т.д. — если нужно, расширишь
}
export type VerifyBookingResult = {
  /** API может вернуть объект или массив (пустой = нет варианта по старым условиям) */
  booking?: VerifyBookingRs | VerifyBookingRs[] | null
  /** API может вернуть объект или массив (актуальный вариант при изменении цены/доступности) */
  alternativeBooking?: VerifyBookingRs | VerifyBookingRs[] | null
  warnings?: Array<{ code?: string | null; message?: string | null }> | null
}

// Расширенный тип с информацией о ценах для сравнения
export type VerifyBookingResultWithPrices = VerifyBookingResult & {
  originalPrice?: number | null
  alternativePrice?: number | null
  priceDifference?: number | null
  currencyCode?: string | null
}

export type CreateBookingRq = {
  propertyId: string
  roomStays: BookingRoomStayRq[]
  services?: BookingServiceRq[] | null
  customer: BookingCustomer
  prepayment?: BookingPrepayment | null
  bookingComments?: string[] | null
  corporateId?: string | null
  /** ОБЯЗАТЕЛЬНО! приходит из /v1/bookings/verify */
  createBookingToken: string
}
export type CreateBookingRequest = { booking: CreateBookingRq }

export type CreatedBooking = {
  number?: string | null // номер брони
  status: 'Confirmed' | 'Cancelled'
  currencyCode?: string | null
  total: { priceBeforeTax: number; taxAmount: number; taxes?: any[] | null }
  cancellationPolicy?: {
    freeCancellationPossible?: boolean
    freeCancellationDeadlineLocal?: string | null
    freeCancellationDeadlineUtc?: string | null
    penaltyAmount?: number | null
  }
  // + куча полей, при необходимости добавишь
}
export type CreateBookingResult = { booking: CreatedBooking }

/** ===== Read/Cancel/Penalty/Modify ===== */

export type GetBookingRs = { booking: CreatedBooking }

export type BookingCancellationRq = {
  reason?: string | null
  expectedPenaltyAmount?: number | null
}

export type ResultOfCalculatePenalty = { penaltyAmount: number }

export type ModifyBookingRq = {
  propertyId: string
  roomStays: BookingRoomStayRq[]
  services?: BookingServiceRq[] | null
  customer: BookingCustomer
  prepayment?: BookingPrepayment | null
  bookingComments?: string[] | null
  corporateId?: string | null
  version: string // из GET /v1/bookings/{number}
}
export type VerifyModificationRs = { booking: any } // упростим
export type VerifyModificationResult = { booking: any }

/**
 * ===== Service =====
 */
@Injectable()
export class ReservationService {
  private readonly tlBase = (process.env.TL_BASE || 'https://partner.qatl.ru').replace(/\/$/, '')
  private readonly base = `${this.tlBase}/api/reservation`
  private readonly logger = new Logger(ReservationService.name)

  constructor(
    private readonly oauth: OAuthService,
    private readonly authService: AuthService,
    private readonly users: UserService,
    private readonly mail: MailService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Берём stayDates из TLRoomStay, если они есть (содержат корректные времена).
   * Если в ответе их нет, шлём только даты без времени.
   */
  buildStayDatesFromRoomStay(
    roomStay: TLRoomStay,
    arrival: string,
    departure: string,
    checkInTime?: string,
    checkOutTime?: string,
  ): BookingStayDates {
    let arrivalDateTime =
      (roomStay as any)?.stayDates?.arrivalDateTime ?? arrival
    let departureDateTime =
      (roomStay as any)?.stayDates?.departureDateTime ?? departure

    // Заезд: время НЕ подставляем.
    // TravelLine ожидает дефолтное время заезда отеля и при передаче "чужого" времени
    // возвращает "Check-in time should be the default time".
    // Передаём только дату — API подставит default check-in самостоятельно.
    // Выезд: если время не пришло из roomStay, подставляем дефолтное время отеля из запроса.
    // Это убирает лишний retry verify в кейсах, где API отклоняет дату без времени.
    if (departureDateTime && !departureDateTime.includes('T') && checkOutTime) {
      departureDateTime = `${departureDateTime}T${checkOutTime}`
    }

    return {
      arrivalDateTime,
      departureDateTime,
    }
  }

  /**
   * Маппинг из TLRoomStay (Search API) в BookingRoomStayRq.
   * НУЖНО: ratePlan.id, roomType.id, checksum, placements (коды), даты и гости.
   * guests[] — имена/фамилии конкретных гостей; если их пока нет — можно отправить одного как customer (минимально ок).
   */
  buildRoomStayRq(
    rs: TLRoomStay,
    stayDates: BookingStayDates,
    guestsCount: BookingGuestCount,
    guests: BookingGuest[],
  ): BookingRoomStayRq {
    const placementsRaw = rs.roomType?.placements ?? []
    const placements: BookingPlacementRq[] = placementsRaw
      .map((p: any) => p?.code ?? p?.kind ?? null)
      .filter((code: string | null): code is string => Boolean(code))
      .map((code) => ({ code }))

    return {
      stayDates,
      ratePlan: { id: (rs as any)?.ratePlan?.id ?? '' },
      roomType: {
        id: rs.roomType?.id ?? '',
        placements: placements.length ? placements : [{ code: 'AdultBed-1' }],
      },
      guests: guests.length
        ? guests
        : [
            {
              firstName: 'Guest',
              lastName: 'Primary',
            },
          ],
      guestCount: {
        adultCount: guestsCount.adultCount,
        childAges: guestsCount.childAges ?? [],
      },
      checksum: (rs as any)?.checksum ?? '',
      services: null,
      extraStay: null,
      // API требует поле body в room stay; если Search не вернул — отправляем пустой объект
      body: (rs as any)?.body ?? {},
    }
  }

  private isCompleteRoomStay(rs: any): boolean {
    // TLRoomStay формат: roomType.id, ratePlan.id, checksum, body
    // RoomOffer формат: roomTypeId, ratePlanId, checksum, body
    // body должен быть реальным opaque полем от Search API (пустой {} часто отклоняется verify).
    // Если body нет/пустой — нужно догидрировать roomStay через fetchRoomStays.
    const hasRoomType = rs?.roomType?.id || rs?.roomTypeId
    const hasRatePlan = rs?.ratePlan?.id || rs?.ratePlanId
    const hasChecksum = !!rs?.checksum
    const hasBody = this.hasNonEmptyBody(rs?.body)
    return Boolean(hasRoomType && hasRatePlan && hasChecksum && hasBody)
  }

  private hasNonEmptyBody(body: any): boolean {
    if (body === undefined || body === null) return false
    if (typeof body !== 'object') return true
    if (Array.isArray(body)) return body.length > 0
    return Object.keys(body).length > 0
  }

  private async hydrateRoomStay(params: {
    roomStay: any
    propertyId: string
    arrival: string
    departure: string
    guestsCount: BookingGuestCount
  }): Promise<TLRoomStay> {
    const { roomStay, propertyId, arrival, departure, guestsCount } = params
    if (this.isCompleteRoomStay(roomStay)) {
      this.logger.debug(`hydrateRoomStay: roomStay is complete, skipping fetch`)
      // Если пришёл RoomOffer (roomTypeId вместо roomType.id), нормализуем в TLRoomStay-like
      if (roomStay.roomTypeId && !roomStay.roomType?.id) {
        return {
          ...roomStay,
          roomType: {
            id: roomStay.roomTypeId,
            name: roomStay.roomTypeName,
            placements: roomStay.placements ?? [],
          },
          ratePlan: { id: roomStay.ratePlanId },
          currencyCode: roomStay.price?.currency ?? 'RUB',
          total: {
            priceBeforeTax: roomStay.price?.total ?? 0,
            priceAfterTax: roomStay.price?.total ?? 0,
          },
        } as any
      }
      return roomStay
    }

    this.logger.warn(
      `hydrateRoomStay: roomStay INCOMPLETE, fetching fresh data. ` +
      `roomType.id=${roomStay?.roomType?.id}, roomTypeId=${roomStay?.roomTypeId}, ` +
      `ratePlan.id=${roomStay?.ratePlan?.id}, ratePlanId=${roomStay?.ratePlanId}, checksum=${!!roomStay?.checksum}`,
    )

    const desiredRatePlanId = roomStay?.ratePlan?.id ?? roomStay?.ratePlanId
    const desiredRoomTypeId = roomStay?.roomType?.id ?? roomStay?.roomTypeId
    const desiredChecksum = roomStay?.checksum
    const currency =
      roomStay?.currencyCode ??
      roomStay?.price?.currency ??
      roomStay?.currency ??
      'RUB'

    const roomStays = await this.fetchRoomStays(
      propertyId,
      arrival,
      departure,
      guestsCount,
      currency,
    )

    const byChecksum = desiredChecksum
      ? roomStays.find((rs) => rs.checksum === desiredChecksum)
      : null

    if (byChecksum) {
      return byChecksum
    }

    const byPlanOrRoom = roomStays.find((rs) => {
      if (
        desiredRatePlanId &&
        String((rs as any)?.ratePlan?.id) === String(desiredRatePlanId)
      ) {
        return true
      }

      return !!(
        desiredRoomTypeId &&
        String(rs.roomType?.id) === String(desiredRoomTypeId)
      )
    })

    if (!byPlanOrRoom) {
      throw new BadRequestException(
        'Выбранный номер недоступен на указанные даты. Попробуйте обновить результаты поиска.',
      )
    }

    // ВАЖНО:
    // Если клиент прислал checksum, но в свежем поиске exact-совпадения нет,
    // это как раз кейс "условия изменились". Нельзя подменять checksum на актуальный,
    // иначе verify пройдёт как "цена не изменилась" и бронь может создаться автоматически.
    if (desiredChecksum) {
      this.logger.warn(
        `hydrateRoomStay: checksum mismatch, preserving client checksum for verify flow`,
      )
      return {
        ...(byPlanOrRoom as any),
        checksum: desiredChecksum,
        // Если body в клиентском payload пустой/нет — используем найденный roomStay.
        body: this.hasNonEmptyBody(roomStay?.body)
          ? roomStay.body
          : (byPlanOrRoom as any)?.body ?? {},
        // внутренний флаг для quickBook: checksum из клиента не совпал с актуальным в поиске
        __checksumMismatch: true,
      } as TLRoomStay
    }

    return byPlanOrRoom
  }

  private async fetchRoomStays(
    propertyId: string,
    arrival: string,
    departure: string,
    guestsCount: BookingGuestCount,
    currency: string,
  ): Promise<TLRoomStay[]> {
    const baseUrl = `${this.tlBase}/api/search/v1/properties/${propertyId}/room-stays`
    const qs = new URLSearchParams({
      adults: String(guestsCount.adultCount),
      arrivalDate: arrival,
      departureDate: departure,
      currencyCode: currency,
    })
    for (const age of guestsCount.childAges ?? []) {
      qs.append('childAges', String(age))
    }

    const url = `${baseUrl}?${qs.toString()}`
    try {
      this.logger.debug(
        `OUTBOUND search call (GET) -> ${url}`,
      )
      const resp = await this.oauth.get<{ roomStays: TLRoomStay[] }>(url)
      if (resp?.roomStays?.length) {
        return resp.roomStays
      }
    } catch (error) {
      // fallback to POST below
    }

    this.logger.debug(
      `OUTBOUND search call (POST) -> ${baseUrl} adults=${guestsCount.adultCount} arrival=${arrival} departure=${departure} currency=${currency}`,
    )
    const altResp = await this.oauth.post<{ roomStays: TLRoomStay[] }>(
      baseUrl,
      {
        adults: guestsCount.adultCount,
        childAges: guestsCount.childAges ?? [],
        arrivalDate: arrival,
        departureDate: departure,
        pricePreference: {
          currencyCode: currency,
          minPrice: 0,
          maxPrice: 100000,
        },
      },
    )

    return altResp?.roomStays ?? []
  }

  /**
   * Проверка возможности создать бронь (обязательна для получения createBookingToken)
   */
  async verifyBooking(payload: VerifyBookingRequest) {
    const url = `${this.base}/v1/bookings/verify`
    try {
      return await this.oauth.post<VerifyBookingResult>(url, payload)
    } catch (error) {
      this.handleAxiosError(error, 'verifyBooking')
    }
  }

  /**
   * Создать бронь (нужен createBookingToken из verify)
   */
  async createBooking(payload: CreateBookingRequest) {
    const url = `${this.base}/v1/bookings`
    this.logger.log(
      `createBooking: calling TravelLine API for propertyId=${payload.booking?.propertyId}, token=${payload.booking?.createBookingToken?.slice(0, 12)}...`,
    )
    try {
      const res = await this.oauth.post<CreateBookingResult>(url, payload)
      this.logger.log(
        `createBooking: TravelLine responded, bookingNumber=${res?.booking?.number ?? 'NONE'}, status=${res?.booking?.status ?? 'NONE'}`,
      )

      try {
        await this.processBookingSideEffects(payload, res)
      } catch (error) {
        const stack = error instanceof Error ? error.stack : undefined
        const message =
          error instanceof Error
            ? error.message
            : 'Unknown error during booking side effects'
        this.logger.error(
          `Failed to process booking side effects: ${message}`,
          stack,
        )
      }

      return res
    } catch (error) {
      this.handleAxiosError(error, 'createBooking')
    }
  }

  private parseDateTime(value?: string | null) {
    if (!value) return null
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }

  private formatDateForEmail(value: Date | null) {
    if (!value) return null
    try {
      return format(value, 'dd.MM.yyyy HH:mm')
    } catch {
      return null
    }
  }

  private formatDateOnlyForEmail(value: Date | null) {
    if (!value) return null
    try {
      return format(value, 'dd.MM.yyyy')
    } catch {
      return null
    }
  }

  private formatTimeForEmail(value: Date | null) {
    if (!value) return null
    try {
      return format(value, 'HH:mm')
    } catch {
      return null
    }
  }

  private getNightsCount(arrival: Date | null, departure: Date | null) {
    if (!arrival || !departure) return null
    const oneDayMs = 24 * 60 * 60 * 1000
    const diff = Math.round(
      (departure.getTime() - arrival.getTime()) / oneDayMs,
    )
    return diff > 0 ? diff : null
  }

  // Шаблон использует форму "ноч{{nights_suffix}}"
  // 1 -> ночь, 2-4 -> ночи, 5+ -> ночей
  private getNightsSuffix(nights: number | null) {
    if (!nights || nights <= 0) return 'ей'
    const mod10 = nights % 10
    const mod100 = nights % 100
    if (mod10 === 1 && mod100 !== 11) return 'ь'
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'и'
    return 'ей'
  }

  private getSiteUrl() {
    const raw =
      process.env.SITE_URL ||
      process.env.FRONTEND_URL ||
      'https://tourist-tours.ru'
    return raw.replace(/\/+$/, '')
  }

  private extractEmail(payload: CreateBookingRequest) {
    return (
      payload?.booking?.customer?.contacts?.emails
        ?.find((email) => email?.emailAddress?.trim())
        ?.emailAddress?.trim() ?? null
    )
  }

  private extractEmailFromCreatedBooking(result?: CreateBookingResult | null) {
    const bookingAny = result?.booking as any
    return (
      bookingAny?.customer?.contacts?.emails
        ?.find((email: any) => email?.emailAddress?.trim())
        ?.emailAddress?.trim() ?? null
    )
  }

  private extractPhone(payload: CreateBookingRequest) {
    return (
      payload?.booking?.customer?.contacts?.phones
        ?.find((phone) => phone?.phoneNumber?.trim())
        ?.phoneNumber?.trim() ?? null
    )
  }

  private async sendCancellationNotification(number: string) {
    const context = await this.users.getBookingNotificationContext(number)
    if (!context?.user?.email) {
      this.logger.warn(
        `Booking ${number} cancelled but notification email is missing.`,
      )
      return
    }

    const siteUrl = this.getSiteUrl()
    const cancellationTemplateId = process.env.RUSENDER_TEMPLATE_CANCELLATION
    const arrival = this.formatDateOnlyForEmail(context.arrivalDate ?? null) ?? ''
    const departure =
      this.formatDateOnlyForEmail(context.departureDate ?? null) ?? ''
    const customerName = [context.user.firstName, context.user.lastName]
      .filter(Boolean)
      .join(' ')
      .trim()

    const textLines = [
      `Бронирование ${number} отменено.`,
      arrival && departure ? `Даты: ${arrival} - ${departure}` : null,
      `Дата отмены: ${this.formatDateForEmail(new Date()) ?? ''}`,
    ].filter((line): line is string => Boolean(line))

    await this.mail.sendMail({
      to: context.user.email,
      subject: `Отмена бронирования ${number}`,
      text: textLines.join('\n'),
      ...(cancellationTemplateId
        ? {
            templateId: cancellationTemplateId,
            templateVariables: {
              booking_id: number,
              name: customerName || context.user.email,
              hotel_name: context.propertyId
                ? `Отель #${context.propertyId}`
                : 'Отель',
              check_in_date: arrival,
              check_out_date: departure,
              cancellation_date: this.formatDateForEmail(new Date()) ?? '',
              refund_amount:
                context.totalAmount != null ? context.totalAmount.toFixed(2) : '',
              currency: context.currency ?? 'RUB',
              refund_method: 'На исходный способ оплаты',
              refund_timeline: '3-10 рабочих дней',
              rebook_url: `${siteUrl}/hotels`,
              support_email:
                process.env.SUPPORT_EMAIL ?? 'support@tourist-tours.ru',
              current_year: new Date().getFullYear(),
              unsubscribe_url:
                process.env.RUSENDER_UNSUBSCRIBE_URL ??
                `${siteUrl}/unsubscribe`,
            },
          }
        : {}),
    })
  }

  private calcGuestsCount(roomStay?: BookingRoomStayRq) {
    if (!roomStay?.guestCount) return null
    const adults = roomStay.guestCount.adultCount ?? 0
    const children = roomStay.guestCount.childAges?.length ?? 0
    const total = adults + children
    return total > 0 ? total : null
  }

  /** Стоимость проживания (subtotal) без налогов и сборов */
  private getTotalAmount(result?: CreateBookingResult) {
    const total = result?.booking?.total
    if (!total) return null
    const subtotal = total.priceBeforeTax ?? 0
    return Number.isFinite(subtotal) ? subtotal : null
  }

  private async processBookingSideEffects(
    payload: CreateBookingRequest,
    result?: CreateBookingResult | null,
  ) {
    const booking = result?.booking
    if (!booking?.number) {
      return
    }

    const email =
      this.extractEmail(payload) || this.extractEmailFromCreatedBooking(result)
    if (!email) {
      this.logger.warn(
        `Booking ${booking.number} created without customer email in payload/response. Skipping user creation.`,
      )
      return
    }

    const customer = payload.booking?.customer
    if (!customer) {
      this.logger.warn(
        `Booking ${booking.number} created without customer details. Skipping side effects.`,
      )
      return
    }
    const roomStay = payload.booking.roomStays?.[0]
    const arrivalDate = this.parseDateTime(roomStay?.stayDates?.arrivalDateTime)
    const departureDate = this.parseDateTime(
      roomStay?.stayDates?.departureDateTime,
    )
    const guestsCount = this.calcGuestsCount(roomStay)

    const ensure = await this.authService.ensureUserForBooking({
      email,
      firstName: customer?.firstName ?? null,
      lastName: customer?.lastName ?? null,
      phone: this.extractPhone(payload),
    })

    const totalAmount = this.getTotalAmount(result ?? undefined)

    await this.users.saveBooking(ensure.user.id, {
      number: booking.number,
      status: booking.status ?? 'Confirmed',
      propertyId: payload.booking.propertyId ?? null,
      arrivalDate,
      departureDate,
      guestsCount,
      totalAmount,
      currency: booking.currencyCode ?? null,
      payload: booking as any,
    })

    const arrivalFormatted = this.formatDateForEmail(arrivalDate)
    const departureFormatted = this.formatDateForEmail(departureDate)
    const totalLine =
      totalAmount != null
        ? `Сумма: ${totalAmount.toFixed(2)} ${booking.currencyCode ?? ''}`.trim()
        : null

    const lines = [
      `Ваш номер брони: ${booking.number}`,
      arrivalFormatted ? `Заезд: ${arrivalFormatted}` : null,
      departureFormatted ? `Выезд: ${departureFormatted}` : null,
      // totalLine,
    ].filter((line): line is string => Boolean(line))

    const nights = this.getNightsCount(arrivalDate, departureDate)
    const roomType =
      roomStay?.roomType?.id || (roomStay as any)?.roomType?.name || 'Не указан'
    const mealPlan =
      roomStay?.ratePlan?.id || (roomStay as any)?.ratePlan?.name || 'Не указано'
    const siteUrl = this.getSiteUrl()
    const bookingTemplateId = process.env.RUSENDER_TEMPLATE_BOOKING
    const customerName = [customer?.firstName, customer?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim()
    const paymentStatus =
      payload?.booking?.prepayment?.paymentType === 'PrePay'
        ? 'Оплачено'
        : 'Без оплаты'
    const cancellationPolicyShort =
      booking?.cancellationPolicy?.freeCancellationPossible === true
        ? booking?.cancellationPolicy?.freeCancellationDeadlineLocal
          ? `Бесплатная отмена до ${booking.cancellationPolicy.freeCancellationDeadlineLocal}`
          : 'Бесплатная отмена доступна'
        : booking?.cancellationPolicy?.penaltyAmount != null
          ? `Штраф ${booking.cancellationPolicy.penaltyAmount} ${booking.currencyCode ?? ''}`.trim()
          : 'Согласно правилам тарифа'

    await this.mail.sendMail({
      to: email,
      subject: `Подтверждение бронирования ${booking.number}`,
      text: lines.join('\n'),
      ...(bookingTemplateId
        ? {
            templateId: bookingTemplateId,
            templateVariables: {
              booking_id: booking.number,
              name: customerName || email,
              hotel_name: `Отель #${payload.booking.propertyId}`,
              city: '',
              check_in_date: this.formatDateOnlyForEmail(arrivalDate) ?? '',
              check_out_date: this.formatDateOnlyForEmail(departureDate) ?? '',
              nights: nights ?? '',
              nights_suffix: this.getNightsSuffix(nights),
              guests: guestsCount ?? '',
              room_type: roomType,
              meal_plan: mealPlan,
              total_price:
                totalAmount != null ? totalAmount.toFixed(2) : '',
              currency: booking.currencyCode ?? 'RUB',
              payment_status: paymentStatus,
              check_in_time: this.formatTimeForEmail(arrivalDate) ?? '',
              check_out_time: this.formatTimeForEmail(departureDate) ?? '',
              cancellation_policy_short: cancellationPolicyShort,
              manage_booking_url: `${siteUrl}/acc/orders`,
              support_email:
                process.env.SUPPORT_EMAIL ?? 'support@tourist-tours.ru',
              support_phone: process.env.SUPPORT_PHONE ?? '',
              current_year: new Date().getFullYear(),
              unsubscribe_url:
                process.env.RUSENDER_UNSUBSCRIBE_URL ??
                `${siteUrl}/unsubscribe`,
            },
          }
        : {}),
    })

    this.logger.log(
      `Booking confirmation mail flow finished for booking=${booking.number}, email=${email}`,
    )
  }

  /**
   * Получить бронь по номеру
   */
  async getBooking(number: string) {
    const url = `${this.base}/v1/bookings/${encodeURIComponent(number)}`
    try {
      return await this.oauth.get<GetBookingRs>(url)
    } catch (error) {
      this.handleAxiosError(error, 'getBooking')
    }
  }

  /**
   * Отменить бронь
   */
  async cancelBooking(number: string, body: BookingCancellationRq) {
    const url = `${this.base}/v1/bookings/${encodeURIComponent(number)}/cancel`
    try {
      const result = await this.oauth.post<GetBookingRs>(url, body)

      // Обновляем статус в локальной БД
      try {
        const newStatus = result?.booking?.status ?? 'Cancelled'
        await this.users.updateBookingStatus(number, newStatus)
        this.logger.log(`Booking ${number} cancelled, DB status updated to ${newStatus}`)
      } catch (dbErr) {
        this.logger.error(`Failed to update DB status for cancelled booking ${number}: ${dbErr}`)
      }

      try {
        await this.sendCancellationNotification(number)
      } catch (mailErr) {
        this.logger.error(
          `Failed to send cancellation email for booking ${number}: ${mailErr}`,
        )
      }

      return result
    } catch (error) {
      this.handleAxiosError(error, 'cancelBooking')
    }
  }

  /**
   * Посчитать штраф за отмену.
   * API требует дату в формате yyyy-MM-ddTHH:mm:ssZ (без миллисекунд).
   */
  async calculatePenalty(number: string, cancellationDateTimeUtc: string) {
    const normalized = cancellationDateTimeUtc.replace(/\.\d{3}Z$/i, 'Z')
    const qs = new URLSearchParams({ cancellationDateTimeUtc: normalized }).toString()
    const url = `${this.base}/v1/bookings/${encodeURIComponent(number)}/calculate-cancellation-penalty?${qs}`
    try {
      return await this.oauth.get<ResultOfCalculatePenalty>(url)
    } catch (error) {
      this.handleAxiosError(error, 'calculatePenalty')
    }
  }

  /**
   * Проверка возможности модификации
   */
  async verifyModification(
    number: string,
    payload: { booking: ModifyBookingRq },
  ) {
    const url = `${this.base}/v1/bookings/${encodeURIComponent(number)}/verify`
    try {
      return await this.oauth.post<VerifyModificationResult>(url, payload)
    } catch (error) {
      this.handleAxiosError(error, 'verifyModification')
    }
  }

  /**
   * Изменить бронирование
   */
  async modifyBooking(number: string, payload: { booking: ModifyBookingRq }) {
    const url = `${this.base}/v1/bookings/${encodeURIComponent(number)}/modify`
    try {
      return await this.oauth.post<GetBookingRs>(url, payload)
    } catch (error) {
      this.handleAxiosError(error, 'modifyBooking')
    }
  }

  /**
   * Упрощённый сценарий: из выбранного оффера (TLRoomStay) + форма гостя → создать бронь.
   * 1) verify -> берём createBookingToken
   * 2) Если цена изменилась (alternativeBooking) — возвращаем информацию для подтверждения
   * 3) create -> получаем номер/статус (+ возможную оплату у отеля/без оплаты)
   */
  async quickBook(params: {
    propertyId: string
    roomStay: TLRoomStay
    arrival: string // YYYY-MM-DD
    departure: string // YYYY-MM-DD
    guestsCount: BookingGuestCount
    customer: {
      firstName: string
      lastName: string
      phone: string
      email: string
      citizenship?: string
      comment?: string
    }
    guests?: BookingGuest[] // если собираешь на каждого гостя ФИО — передай
    checkInTime?: string // "14:00" — если знаешь из Content API
    checkOutTime?: string // "12:00"
    paymentType?: PaymentType // 'Cash'|'PrePay'  (если нужно фиксировать)
    prepayRemark?: string | null
    prepaySum?: number | null
    perBookingServices?: Array<{ id: string }> // если есть доп. услуги на бронь
    acceptAlternative?: boolean // флаг подтверждения новых условий
    alternativeToken?: string // токен из alternativeBooking для подтверждения
  }) {
    const {
      propertyId,
      roomStay,
      arrival,
      departure,
      guestsCount,
      customer,
      guests = [],
      checkInTime,
      checkOutTime,
      paymentType,
      prepayRemark,
      prepaySum,
      perBookingServices,
      acceptAlternative = false,
      alternativeToken,
    } = params

    this.logChecksumDebug('quickBook incoming roomStay', roomStay?.checksum)

    // Если пользователь подтвердил новые условия и передал токен — создаём бронь
    if (acceptAlternative && alternativeToken) {
      this.logger.log(
        `quickBook: acceptAlternative=true, using provided alternativeToken directly`
      )

      // Сразу создаём бронь с переданным токеном
      const result = await this.createBookingWithToken({
        propertyId,
        roomStay,
        arrival,
        departure,
        guestsCount,
        customer,
        guests,
        checkInTime,
        checkOutTime,
        paymentType,
        prepayRemark,
        prepaySum,
        perBookingServices,
        token: alternativeToken,
      })

      // createBookingWithToken всегда возвращает корректный результат (успех или priceChanged/noAvailability)
      // Просто возвращаем его, не продолжая выполнение
      return result
    }

    // 2) Формируем roomStay без предварительного search-запроса.
    // Если verify вернёт ошибку "body field is required", сделаем hydrate + retry один раз.
    let effectiveRoomStay: TLRoomStay = this.normalizeRoomStayForCreate(roomStay)
    const incomingChecksumAmounts = this.decodeChecksumAmounts(roomStay?.checksum)
    const incomingChecksumTotal = Number(
      incomingChecksumAmounts?.withoutExtras ?? incomingChecksumAmounts?.withExtras ?? NaN,
    )
    const incomingDisplayedPrice =
      roomStay?.total?.priceBeforeTax ??
      roomStay?.total?.priceAfterTax ??
      (roomStay as any)?.price?.total ??
      null
    let checksumMismatchDetected =
      Number.isFinite(incomingChecksumTotal) &&
      incomingDisplayedPrice != null &&
      Math.abs(incomingChecksumTotal - Number(incomingDisplayedPrice)) > 0.009

    let stayDates = this.buildStayDatesFromRoomStay(
      effectiveRoomStay,
      arrival,
      departure,
      checkInTime,
      checkOutTime,
    )

    let roomStaysRq: BookingRoomStayRq[] = [
      this.buildRoomStayRq(effectiveRoomStay, stayDates, guestsCount, guests),
    ]
    this.logChecksumDebug('quickBook outgoing verify roomStay', roomStaysRq[0]?.checksum)

    this.logger.debug(
      `roomStay request for verify: ${JSON.stringify(roomStaysRq[0], null, 2)}`,
    )

    // 3) контакты клиента (обязательны phones+emails)
    const bookingCustomer: BookingCustomer = {
      firstName: customer.firstName,
      lastName: customer.lastName,
      citizenship: customer.citizenship,
      contacts: {
        phones: [{ phoneNumber: customer.phone }],
        emails: [{ emailAddress: customer.email }],
      },
      comment: customer.comment,
    }

    // 4) prepayment — всегда передаём сумму предоплаты, чтобы TravelLine видел её в отчётах
    let resolvedPrepaySum =
      prepaySum ??
      effectiveRoomStay?.total?.priceBeforeTax ??
      effectiveRoomStay?.total?.priceAfterTax ??
      (roomStay as any)?.price?.total ??
      undefined
    let prepayment: BookingPrepayment = {
      paymentType: paymentType ?? 'PrePay',
      remark: prepayRemark ?? undefined,
      prepaidSum: resolvedPrepaySum,
    }

    // 5) VERIFY (получить createBookingToken)
    let verifyPayload: VerifyBookingRequest = {
      booking: {
        propertyId,
        roomStays: roomStaysRq,
        customer: bookingCustomer,
        prepayment,
        services: perBookingServices ?? null,
      },
    }

    let verifyRes: VerifyBookingResult
    try {
      verifyRes = await this.verifyBooking(verifyPayload)
    } catch (error) {
      if (!this.isBodyRequiredError(error)) {
        throw error
      }
      this.logger.warn(
        `quickBook: verify requires non-empty body, hydrating roomStay and retrying verify once`,
      )

      effectiveRoomStay = await this.hydrateRoomStay({
        roomStay,
        propertyId,
        arrival,
        departure,
        guestsCount,
      })
      checksumMismatchDetected =
        checksumMismatchDetected || !!(effectiveRoomStay as any)?.__checksumMismatch

      stayDates = this.buildStayDatesFromRoomStay(
        effectiveRoomStay,
        arrival,
        departure,
        checkInTime,
        checkOutTime,
      )
      roomStaysRq = [
        this.buildRoomStayRq(effectiveRoomStay, stayDates, guestsCount, guests),
      ]
      this.logChecksumDebug('quickBook outgoing verify roomStay (retry)', roomStaysRq[0]?.checksum)
      this.logger.debug(
        `roomStay request for verify (retry): ${JSON.stringify(roomStaysRq[0], null, 2)}`,
      )

      resolvedPrepaySum =
        prepaySum ??
        effectiveRoomStay?.total?.priceBeforeTax ??
        effectiveRoomStay?.total?.priceAfterTax ??
        (roomStay as any)?.price?.total ??
        undefined
      prepayment = {
        paymentType: paymentType ?? 'PrePay',
        remark: prepayRemark ?? undefined,
        prepaidSum: resolvedPrepaySum,
      }
      verifyPayload = {
        booking: {
          propertyId,
          roomStays: roomStaysRq,
          customer: bookingCustomer,
          prepayment,
          services: perBookingServices ?? null,
        },
      }
      verifyRes = await this.verifyBooking(verifyPayload)
    }

    const bookingToken = this.getVerifyBookingToken(verifyRes)
    const alternativeTokenObj = this.getVerifyAlternativeBooking(verifyRes)

    // Логируем подробно для отладки
    this.logger.debug(
      `quickBook verify result:\n` +
      `  - booking type: ${Array.isArray(verifyRes?.booking) ? 'array' : typeof verifyRes?.booking}\n` +
      `  - booking length: ${Array.isArray(verifyRes?.booking) ? (verifyRes.booking as any[]).length : 'N/A'}\n` +
      `  - bookingToken: ${!!bookingToken?.createBookingToken}\n` +
      `  - alternativeBooking type: ${Array.isArray(verifyRes?.alternativeBooking) ? 'array' : typeof verifyRes?.alternativeBooking}\n` +
      `  - alternativeBooking length: ${Array.isArray(verifyRes?.alternativeBooking) ? (verifyRes.alternativeBooking as any[]).length : 'N/A'}\n` +
      `  - alternativeToken: ${!!alternativeTokenObj?.createBookingToken}`
    )

    // Если нет ни одного токена - нет доступности
    if (!bookingToken?.createBookingToken && !alternativeTokenObj?.createBookingToken) {
      this.logger.warn(`quickBook: no tokens returned, no availability`)
      return {
        verify: verifyRes,
        created: null,
        priceChanged: false,
        noAvailability: true,
        message:
          (verifyRes?.warnings?.[0]?.message as string) ||
          'Номера по выбранным условиям закончились. Выполните повторный поиск.',
        warnings: verifyRes?.warnings,
      }
    }

    // ПРИОРИТЕТ: если есть alternativeToken - значит цена/условия изменились
    // НЕ создаём бронь, возвращаем информацию для подтверждения пользователем
    if (alternativeTokenObj?.createBookingToken) {
      const originalPrice =
        roomStay?.total?.priceBeforeTax ?? roomStay?.total?.priceAfterTax ?? null
      const alternativePrice = this.extractPriceFromVerifyResult(alternativeTokenObj)
      const currencyCode = roomStay?.currencyCode ?? 'RUB'
      const alternativeToken = alternativeTokenObj.createBookingToken

      await this.cacheAlternativeRoomStay(alternativeToken, effectiveRoomStay)

      this.logger.warn(
        `quickBook: price/availability changed (${originalPrice} -> ${alternativePrice} ${currencyCode}), NOT creating booking`,
      )

      return {
        verify: verifyRes,
        created: null,
        priceChanged: true,
        originalPrice,
        alternativePrice,
        priceDifference:
          alternativePrice != null && originalPrice != null
            ? alternativePrice - originalPrice
            : null,
        currencyCode,
        alternativeToken,
        warnings: verifyRes.warnings,
      }
    }

    // Защитный сценарий:
    // even if verify вернул bookingToken, при mismatch checksum НЕ создаём бронь автоматически,
    // а требуем явного подтверждения пользователем (как при alternativeBooking).
    if (
      bookingToken?.createBookingToken &&
      !alternativeTokenObj?.createBookingToken &&
      ((effectiveRoomStay as any)?.__checksumMismatch || checksumMismatchDetected)
    ) {
      const verifiedBookingToken = bookingToken as VerifyBookingRs
      const originalPrice =
        roomStay?.total?.priceBeforeTax ?? roomStay?.total?.priceAfterTax ?? null
      const verifiedPrice = this.extractPriceFromVerifyResult(verifiedBookingToken)
      const currencyCode = roomStay?.currencyCode ?? 'RUB'

      this.logger.warn(
        `quickBook: checksum mismatch detected, requiring confirmation (${originalPrice} -> ${verifiedPrice} ${currencyCode})`,
      )
      const alternativeToken = verifiedBookingToken.createBookingToken
      await this.cacheAlternativeRoomStay(alternativeToken, effectiveRoomStay)

      return {
        verify: verifyRes,
        created: null,
        priceChanged: true,
        originalPrice,
        alternativePrice: verifiedPrice,
        priceDifference:
          verifiedPrice != null && originalPrice != null
            ? verifiedPrice - originalPrice
            : null,
        currencyCode,
        // используем валидный create-токен из verify для подтверждения новых условий
        alternativeToken,
        warnings: verifyRes.warnings,
      }
    }

    // Если есть обычный bookingToken (без alternative) - цена НЕ изменилась, создаём бронь
    if (!bookingToken?.createBookingToken) {
      this.logger.error(`quickBook: unexpected state - no bookingToken but no alternativeToken`)
      throw new Error('Unexpected verify result: no tokens available')
    }

    const token = bookingToken.createBookingToken
    this.logger.log(`quickBook: price NOT changed, proceeding to create booking`)

    // 6) CREATE
    const createPayload: CreateBookingRequest = {
      booking: {
        propertyId,
        roomStays: roomStaysRq,
        customer: bookingCustomer,
        prepayment,
        services: perBookingServices ?? null,
        createBookingToken: token,
      },
    }

    const created = await this.createBooking(createPayload)

    return { verify: verifyRes, created, priceChanged: false }
  }

  /**
   * Нормализация roomStay из запроса (RoomOffer-формат) в вид для buildRoomStayRq без запросов к API.
   * Используется при создании брони по alternativeToken, чтобы не делать повторный verify/search.
   */
  private normalizeRoomStayForCreate(rs: any): TLRoomStay {
    const roomTypeId = rs?.roomType?.id ?? rs?.roomTypeId ?? ''
    const ratePlanId = (rs as any)?.ratePlan?.id ?? (rs as any)?.ratePlanId ?? ''
    const placements = rs?.roomType?.placements ?? rs?.placements ?? []
    return {
      propertyId: (rs as any)?.propertyId ?? '',
      stayDates: (rs as any)?.stayDates ?? undefined,
      roomType: {
        id: roomTypeId,
        name: (rs as any)?.roomTypeName,
        placements: Array.isArray(placements) ? placements : [],
      },
      ratePlan: { id: ratePlanId },
      checksum: (rs as any)?.checksum ?? '',
      body: this.hasNonEmptyBody((rs as any)?.body) ? (rs as any).body : {},
      total: (rs as any)?.total ?? { priceBeforeTax: (rs as any)?.price?.total, priceAfterTax: (rs as any)?.price?.total },
      currencyCode: (rs as any)?.currencyCode ?? (rs as any)?.price?.currency ?? 'RUB',
    } as TLRoomStay
  }

  /**
   * Создание брони с уже полученным токеном (для подтверждения альтернативных условий).
   * ВАЖНО: alternativeToken - это createBookingToken, готовый для создания брони.
   * Повторный verify/search не вызывается — используем только переданный roomStay и токен.
   */
  private async createBookingWithToken(params: {
    propertyId: string
    roomStay: TLRoomStay
    arrival: string
    departure: string
    guestsCount: BookingGuestCount
    customer: {
      firstName: string
      lastName: string
      phone: string
      email: string
      citizenship?: string
      comment?: string
    }
    guests: BookingGuest[]
    checkInTime?: string
    checkOutTime?: string
    paymentType?: PaymentType
    prepayRemark?: string | null
    prepaySum?: number | null
    perBookingServices?: Array<{ id: string }>
    token: string
  }) {
    const {
      propertyId,
      roomStay,
      arrival,
      departure,
      guestsCount,
      customer,
      guests,
      checkInTime,
      checkOutTime,
      paymentType,
      prepayRemark,
      prepaySum,
      perBookingServices,
      token,
    } = params

    // Нормализация переданного roomStay.
    // Если body пустой, догидрируем из Search API (без verify) для валидного create payload.
    this.logChecksumDebug('createWithToken incoming roomStay', roomStay?.checksum)
    const cachedHydratedRoomStay = await this.getCachedAlternativeRoomStay(token)
    let normalizedRoomStay = cachedHydratedRoomStay
      ? (cachedHydratedRoomStay as TLRoomStay)
      : this.normalizeRoomStayForCreate(roomStay)

    if (cachedHydratedRoomStay) {
      this.logger.log(
        `createBookingWithToken: using cached hydrated roomStay from verify (no re-search)`,
      )
      if (!this.hasNonEmptyBody((normalizedRoomStay as any)?.body)) {
        this.logger.warn(
          `createBookingWithToken: cached roomStay has empty body, hydrating from search for valid create payload`,
        )
        normalizedRoomStay = await this.hydrateRoomStay({
          roomStay,
          propertyId,
          arrival,
          departure,
          guestsCount,
        })
      }
    } else if (!this.hasNonEmptyBody((normalizedRoomStay as any)?.body)) {
      this.logger.warn(
        `createBookingWithToken: roomStay.body is empty, hydrating from search for valid create payload`,
      )
      normalizedRoomStay = await this.hydrateRoomStay({
        roomStay,
        propertyId,
        arrival,
        departure,
        guestsCount,
      })
    }
    const stayDates = this.buildStayDatesFromRoomStay(
      normalizedRoomStay,
      arrival,
      departure,
      checkInTime,
      checkOutTime,
    )

    const roomStaysRq: BookingRoomStayRq[] = [
      this.buildRoomStayRq(normalizedRoomStay, stayDates, guestsCount, guests),
    ]
    this.logChecksumDebug('createWithToken outgoing create roomStay', roomStaysRq[0]?.checksum)

    const bookingCustomer: BookingCustomer = {
      firstName: customer.firstName,
      lastName: customer.lastName,
      citizenship: customer.citizenship,
      contacts: {
        phones: [{ phoneNumber: customer.phone }],
        emails: [{ emailAddress: customer.email }],
      },
      comment: customer.comment,
    }

    const resolvedPrepaySum =
      prepaySum ??
      (normalizedRoomStay as any)?.total?.priceBeforeTax ??
      (normalizedRoomStay as any)?.total?.priceAfterTax ??
      (normalizedRoomStay as any)?.price?.total ??
      (roomStay as any)?.total?.priceBeforeTax ??
      (roomStay as any)?.total?.priceAfterTax ??
      (roomStay as any)?.price?.total ??
      undefined
    const prepayment: BookingPrepayment = {
      paymentType: paymentType ?? 'PrePay',
      remark: prepayRemark ?? undefined,
      prepaidSum: resolvedPrepaySum,
    }

    const createPayload: CreateBookingRequest = {
      booking: {
        propertyId,
        roomStays: roomStaysRq,
        customer: bookingCustomer,
        prepayment,
        services: perBookingServices ?? null,
        createBookingToken: token,
      },
    }

    this.logger.log(
      `createBookingWithToken: creating booking with provided alternativeToken (no re-verify)`,
    )

    const created = await this.createBooking(createPayload)

    // Проверяем, что бронь действительно создана
    if (!created?.booking?.number) {
      throw new Error('Booking created but no booking number returned')
    }

    this.logger.log(
      `createBookingWithToken: booking created successfully, number=${created.booking.number}`
    )

    return { verify: null, created, priceChanged: false, acceptedAlternative: true }
  }

  /**
   * Подготовка к оплате: только верификация, сохранение payload в Redis.
   * Бронирование создаётся после подтверждения оплаты (webhook PayKeeper) с суммой в prepayment.prepaidSum.
   */
  async preparePayment(params: {
    propertyId: string
    roomStay: TLRoomStay
    arrival: string
    departure: string
    guestsCount: BookingGuestCount
    customer: {
      firstName: string
      lastName: string
      phone: string
      email: string
      citizenship?: string
      comment?: string
    }
    guests?: BookingGuest[]
    perBookingServices?: Array<{ id: string }> | null
    acceptAlternative?: boolean
    alternativeToken?: string
    /** Сумма к оплате при подтверждении новых условий (alternativePrice) */
    amountForAlternative?: number
  }): Promise<
    | { paymentId: string; amount: number; currencyCode: string }
    | {
        priceChanged: true
        originalPrice: number | null
        alternativePrice: number | null
        priceDifference: number | null
        currencyCode: string
        alternativeToken: string
        warnings?: Array<{ code?: string | null; message?: string | null }> | null
      }
    | { noAvailability: true; message: string; warnings?: Array<{ code?: string | null; message?: string | null }> | null }
  > {
    const {
      propertyId,
      roomStay,
      arrival,
      departure,
      guestsCount,
      customer,
      guests = [],
      perBookingServices = null,
      acceptAlternative = false,
      alternativeToken,
      amountForAlternative,
    } = params

    const bookingCustomer: BookingCustomer = {
      firstName: customer.firstName,
      lastName: customer.lastName,
      citizenship: customer.citizenship,
      contacts: {
        phones: [{ phoneNumber: customer.phone }],
        emails: [{ emailAddress: customer.email }],
      },
      comment: customer.comment,
    }

    let createBookingToken: string
    let amount: number
    const currencyCode = roomStay?.currencyCode ?? 'RUB'

    if (acceptAlternative && alternativeToken) {
      createBookingToken = alternativeToken
      amount =
        amountForAlternative ??
        (roomStay?.total?.priceBeforeTax ?? roomStay?.total?.priceAfterTax ?? 0)
    } else {
      const hydratedRoomStay = await this.hydrateRoomStay({
        roomStay,
        propertyId,
        arrival,
        departure,
        guestsCount,
      })
      const stayDates = this.buildStayDatesFromRoomStay(
        hydratedRoomStay,
        arrival,
        departure,
      )
      const roomStaysRq: BookingRoomStayRq[] = [
        this.buildRoomStayRq(hydratedRoomStay, stayDates, guestsCount, guests),
      ]

      const verifyPayload: VerifyBookingRequest = {
        booking: {
          propertyId,
          roomStays: roomStaysRq,
          customer: bookingCustomer,
          prepayment: undefined,
          services: perBookingServices,
        },
      }

      const verifyRes = await this.verifyBooking(verifyPayload)
      const bookingToken = this.getVerifyBookingToken(verifyRes)
      const alternativeTokenObj = this.getVerifyAlternativeBooking(verifyRes)

      if (!bookingToken?.createBookingToken && !alternativeTokenObj?.createBookingToken) {
        return {
          noAvailability: true,
          message:
            'Номера по выбранным условиям закончились или условия изменились. Вернитесь к поиску и выберите другие даты или вариант.',
          warnings: verifyRes?.warnings,
        }
      }

      if (!bookingToken?.createBookingToken && alternativeTokenObj?.createBookingToken) {
        const originalPrice =
          roomStay?.total?.priceBeforeTax ?? roomStay?.total?.priceAfterTax ?? null
        const alternativePrice = this.extractPriceFromVerifyResult(alternativeTokenObj)
        return {
          priceChanged: true,
          originalPrice,
          alternativePrice: alternativePrice ?? null,
          priceDifference:
            alternativePrice != null && originalPrice != null
              ? alternativePrice - originalPrice
              : null,
          currencyCode,
          alternativeToken: alternativeTokenObj.createBookingToken,
          warnings: verifyRes?.warnings,
        }
      }

      createBookingToken = bookingToken!.createBookingToken
      const verifiedPrice =
        this.extractPriceFromVerifyResult(bookingToken!) ??
        (roomStay?.total?.priceBeforeTax ?? roomStay?.total?.priceAfterTax ?? 0)
      amount = verifiedPrice

      const originalPrice =
        roomStay?.total?.priceBeforeTax ?? roomStay?.total?.priceAfterTax ?? null
      const priceDiff =
        originalPrice != null && verifiedPrice != null
          ? Math.abs(verifiedPrice - originalPrice)
          : 0
      const priceActuallyChanged = priceDiff > 0.01

      if (priceActuallyChanged) {
        return {
          priceChanged: true,
          originalPrice,
          alternativePrice: verifiedPrice,
          priceDifference:
            originalPrice != null ? verifiedPrice - originalPrice : null,
          currencyCode,
          alternativeToken: bookingToken!.createBookingToken,
          warnings: verifyRes?.warnings,
        }
      }

      const paymentId = randomUUID()
      const stored = {
        createBookingToken,
        prepaidSum: amount,
        booking: {
          propertyId,
          roomStays: roomStaysRq,
          customer: bookingCustomer,
          services: perBookingServices,
        },
      }
      await this.redis.setJson(
        `${PENDING_BOOKING_PREFIX}${paymentId}`,
        stored,
        PENDING_BOOKING_TTL_SEC,
      )
      return { paymentId, amount, currencyCode }
    }

    const hydratedRoomStay = await this.hydrateRoomStay({
      roomStay,
      propertyId,
      arrival,
      departure,
      guestsCount,
    })
    const stayDates = this.buildStayDatesFromRoomStay(
      hydratedRoomStay,
      arrival,
      departure,
    )
    const roomStaysRq: BookingRoomStayRq[] = [
      this.buildRoomStayRq(hydratedRoomStay, stayDates, guestsCount, guests),
    ]

    const paymentId = randomUUID()
    const stored = {
      createBookingToken,
      prepaidSum: amount,
      booking: {
        propertyId,
        roomStays: roomStaysRq,
        customer: bookingCustomer,
        services: perBookingServices,
      },
    }
    await this.redis.setJson(
      `${PENDING_BOOKING_PREFIX}${paymentId}`,
      stored,
      PENDING_BOOKING_TTL_SEC,
    )
    return { paymentId, amount, currencyCode }
  }

  /**
   * Создание брони после подтверждения оплаты. Вызывается из webhook PayKeeper.
   * Сумма оплаты передаётся в prepayment.prepaidSum.
   *
   * Если createBookingToken протух (TravelLine вернул ошибку), делаем
   * повторный verify → create с новым токеном (до MAX_RETRIES попыток).
   */
  async createBookingAfterPayment(
    paymentId: string,
    paidSum: string,
  ): Promise<CreateBookingResult | null> {
    const key = `${PENDING_BOOKING_PREFIX}${paymentId}`
    const stored = await this.redis.getJson<{
      createBookingToken: string
      prepaidSum?: number
      booking: {
        propertyId: string
        roomStays: BookingRoomStayRq[]
        customer: BookingCustomer
        services: Array<{ id: string }> | null
      }
    }>(key)

    if (!stored?.createBookingToken || !stored?.booking) {
      this.logger.warn(`createBookingAfterPayment: no pending booking for ${paymentId}`)
      return null
    }

    // Используем сохранённую сумму (priceBeforeTax) из Redis, а не paidSum от PayKeeper,
    // т.к. PayKeeper может прислать сумму с налогами (priceAfterTax),
    // а TravelLine требует prepaidSum <= priceBeforeTax.
    const prepaidSum = stored.prepaidSum ?? Number(paidSum)
    if (!Number.isFinite(prepaidSum) || prepaidSum < 0) {
      this.logger.warn(`createBookingAfterPayment: invalid prepaidSum ${prepaidSum} (paidSum=${paidSum})`)
      return null
    }
    this.logger.log(`createBookingAfterPayment: using prepaidSum=${prepaidSum} (PayKeeper sum=${paidSum})`)

    const prepayment: BookingPrepayment = {
      paymentType: 'PrePay',
      prepaidSum,
    }

    // --- Попытка 1: используем сохранённый токен ---
    const createPayload: CreateBookingRequest = {
      booking: {
        ...stored.booking,
        createBookingToken: stored.createBookingToken,
        prepayment,
      },
    }

    try {
      const result = await this.createBooking(createPayload)
      await this.onBookingCreatedAfterPayment(key, paymentId, result)
      return result
    } catch (firstErr) {
      this.logger.warn(
        `createBookingAfterPayment: first attempt failed for ${paymentId}, will retry with fresh token: ${firstErr}`,
      )
    }

    // --- Попытка 2: re-verify для получения нового токена ---
    try {
      this.logger.log(`createBookingAfterPayment: re-verifying booking for ${paymentId}`)
      const verifyPayload: VerifyBookingRequest = {
        booking: {
          propertyId: stored.booking.propertyId,
          roomStays: stored.booking.roomStays,
          customer: stored.booking.customer,
          prepayment: undefined,
          services: stored.booking.services,
        },
      }

      const verifyRes = await this.verifyBooking(verifyPayload)
      const bookingToken = this.getVerifyBookingToken(verifyRes)
      const altToken = this.getVerifyAlternativeBooking(verifyRes)
      const newToken = bookingToken?.createBookingToken ?? altToken?.createBookingToken

      if (!newToken) {
        this.logger.error(
          `createBookingAfterPayment: re-verify returned no token for ${paymentId}. Payment collected but booking NOT created!`,
        )
        return null
      }

      const retryPayload: CreateBookingRequest = {
        booking: {
          ...stored.booking,
          createBookingToken: newToken,
          prepayment,
        },
      }

      const result = await this.createBooking(retryPayload)
      this.logger.log(`createBookingAfterPayment: retry succeeded for ${paymentId}`)
      await this.onBookingCreatedAfterPayment(key, paymentId, result)
      return result
    } catch (retryErr) {
      this.logger.error(
        `createBookingAfterPayment: retry also FAILED for ${paymentId}. Payment collected but booking NOT created! Error: ${retryErr}`,
      )
      throw retryErr
    }
  }

  /** Общая логика после успешного создания брони из webhook */
  private async onBookingCreatedAfterPayment(
    redisKey: string,
    paymentId: string,
    result?: CreateBookingResult | null,
  ) {
    await this.redis.del(redisKey)
    const bookingNumber = result?.booking?.number
    if (bookingNumber) {
      await this.redis.setJson(
        `${PAYMENT_SUCCESS_PREFIX}${paymentId}`,
        { bookingNumber },
        PAYMENT_SUCCESS_TTL_SEC,
      )
    }
  }

  /**
   * Результат успешной оплаты по paymentId (для страницы success).
   */
  async getPaymentSuccessResult(
    paymentId: string,
  ): Promise<{ bookingNumber: string } | null> {
    return this.redis.getJson(`${PAYMENT_SUCCESS_PREFIX}${paymentId}`)
  }

  /**
   * Нормализация ответа verify: API может вернуть booking/alternativeBooking как массив или объект.
   * Возвращаем один объект или null.
   *
   * ВАЖНО: TravelLine может вернуть:
   * - Объект с токеном: { createBookingToken: "...", ... }
   * - Массив с одним объектом: [{ createBookingToken: "...", ... }]
   * - Пустой массив: [] (означает "нет варианта")
   * - null/undefined (означает "нет варианта")
   */
  private normalizeVerifyBooking(
    raw: VerifyBookingRs | VerifyBookingRs[] | null | undefined,
  ): VerifyBookingRs | null {
    if (raw == null) return null

    // Если массив
    if (Array.isArray(raw)) {
      // Пустой массив = нет варианта
      if (raw.length === 0) return null
      // Берём первый элемент
      const first = raw[0]
      // Проверяем, что у него есть токен
      return first?.createBookingToken ? first : null
    }

    // Если объект - проверяем наличие токена
    return (raw as any)?.createBookingToken ? raw : null
  }

  private getVerifyBookingToken(res: VerifyBookingResult | null | undefined): VerifyBookingRs | null {
    return this.normalizeVerifyBooking(res?.booking as any)
  }

  private getVerifyAlternativeBooking(
    res: VerifyBookingResult | null | undefined,
  ): VerifyBookingRs | null {
    return this.normalizeVerifyBooking(res?.alternativeBooking as any)
  }

  /** Извлечение стоимости проживания (subtotal) без налогов — для предоплаты и отображения */
  private extractPriceFromVerifyResult(verifyRs: VerifyBookingRs): number | null {
    const b = verifyRs as any
    const num =
      b?.total?.priceBeforeTax ??
      b?.total?.priceAfterTax ??
      b?.roomStays?.[0]?.total?.priceBeforeTax ??
      b?.roomStays?.[0]?.total?.priceAfterTax ??
      null
    if (num != null) return typeof num === 'number' ? num : null
    // TravelLine иногда отдаёт сумму строкой (например в alternativeBooking)
    const str =
      b?.total?.amount ?? b?.roomStays?.[0]?.total?.amount ?? b?.TotalAmountAfterTax
    if (str != null) {
      const parsed = typeof str === 'string' ? parseFloat(str) : Number(str)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }

  private extractApiErrors(
    error: AxiosError<{
      errors?: Array<{ message?: string }>
      message?: string
    }>,
  ): string[] {
    const apiErrors = error.response?.data?.errors
    if (Array.isArray(apiErrors) && apiErrors.length) {
      return apiErrors
        .map((item) => item?.message)
        .filter((message): message is string => Boolean(message))
    }
    const message = error.response?.data?.message
    return message ? [message] : []
  }

  private handleAxiosError(error: unknown, context: string): never {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? 502
      const traceId =
        (error.response?.headers?.['x-request-id'] as string | undefined) ??
        undefined
      const errors = this.extractApiErrors(error)
      const fallback = error.response?.statusText || error.message
      const message = errors.length ? errors.join('; ') : fallback

      const logContext = traceId
        ? `${context} [request-id=${traceId}]`
        : context
      this.logger.warn(`Remote API error in ${logContext}: ${message}`)

      throw new HttpException(
        {
          message,
          errors: errors.length ? errors : undefined,
          traceId,
        },
        status,
      )
    }

    this.logger.error(`Unexpected error in ${context}`, error as Error)
    throw error instanceof Error ? error : new Error(String(error))
  }

  /**
   * [DEV ONLY] Эмуляция сценария изменения цены для локального теста.
   * Принимает тело как для quick-book + опционально overrideChecksum.
   * Если передан overrideChecksum — подменяет roomStay.checksum перед вызовом quickBook,
   * чтобы TravelLine вернул пустой booking и актуальное предложение в alternativeBooking.
   */
  async testPriceChangeScenario(body: {
    propertyId: string
    roomStay: any
    arrival: string
    departure: string
    guestsCount: { adultCount: number; childAges?: number[] }
    customer: {
      firstName: string
      lastName: string
      phone: string
      email: string
      citizenship?: string
      comment?: string
    }
    guests?: Array<{ firstName: string; lastName: string; middleName?: string; citizenship?: string }>
    checkInTime?: string
    checkOutTime?: string
    paymentType?: 'Cash' | 'PrePay'
    prepayRemark?: string | null
    prepaySum?: number | null
    perBookingServices?: Array<{ id: string }>
    /** Подмена checksum для эмуляции изменения цены (Base64 JSON с другой TotalAmountAfterTax) */
    overrideChecksum?: string
  }) {
    const { overrideChecksum, ...rest } = body
    const roomStay =
      overrideChecksum && body.roomStay
        ? { ...body.roomStay, checksum: overrideChecksum }
        : body.roomStay
    return this.quickBook({ ...rest, roomStay })
  }

  private decodeChecksumAmounts(
    checksum?: string | null,
  ): { withoutExtras: string | null; withExtras: string | null } | null {
    if (!checksum) return null
    try {
      const raw = Buffer.from(checksum, 'base64').toString('utf-8')
      const parsed = JSON.parse(raw)
      return {
        withoutExtras:
          parsed?.ChecksumWithOutExtras?.TotalAmountAfterTax?.toString?.() ?? null,
        withExtras:
          parsed?.ChecksumWithExtras?.TotalAmountAfterTax?.toString?.() ?? null,
      }
    } catch {
      return null
    }
  }

  private logChecksumDebug(scope: string, checksum?: string | null) {
    if (!checksum) {
      this.logger.debug(`${scope}: checksum is empty`)
      return
    }
    const decoded = this.decodeChecksumAmounts(checksum)
    this.logger.debug(
      `${scope}: checksum=${checksum.slice(0, 24)}... len=${checksum.length}; ` +
        `withoutExtras=${decoded?.withoutExtras ?? 'n/a'}, withExtras=${decoded?.withExtras ?? 'n/a'}`,
    )
  }

  private isBodyRequiredError(error: unknown): boolean {
    const pattern = /body field is required/i
    if (error instanceof HttpException) {
      const response = error.getResponse() as any
      const messageValue =
        typeof response === 'string'
          ? response
          : Array.isArray(response?.message)
            ? response.message.join('; ')
            : response?.message ?? error.message
      return pattern.test(String(messageValue ?? ''))
    }
    if (error instanceof Error) {
      return pattern.test(error.message)
    }
    return false
  }

  private getAltRoomStayCacheKey(token: string) {
    return `${ALT_ROOMSTAY_PREFIX}${encodeURIComponent(token)}`
  }

  private async cacheAlternativeRoomStay(token: string, roomStay: TLRoomStay) {
    this.logger.debug(
      `alt-roomstay cache set: token=${token.slice(0, 16)}..., hasBody=${this.hasNonEmptyBody((roomStay as any)?.body)}`,
    )
    await this.redis.setJson(
      this.getAltRoomStayCacheKey(token),
      roomStay,
      ALT_ROOMSTAY_TTL_SEC,
    )
  }

  private async getCachedAlternativeRoomStay(token: string): Promise<TLRoomStay | null> {
    const cached = await this.redis.getJson<TLRoomStay>(this.getAltRoomStayCacheKey(token))
    this.logger.debug(
      `alt-roomstay cache ${cached ? 'hit' : 'miss'}: token=${token.slice(0, 16)}...`,
    )
    return cached
  }
}
