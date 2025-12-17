import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common'
import { OAuthService } from '~/services'
import { TLRoomStay } from '~/shared' // твой тип из Search API (roomStays)
import { format } from 'date-fns'
import { AuthService } from '~/app/auth/auth.service'
import { UserService } from '~/app/user/user.service'
import { MailService } from '~/services/mail.service'
import axios, { AxiosError } from 'axios'

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
  booking: VerifyBookingRs | null
  alternativeBooking?: VerifyBookingRs | null
  warnings?: Array<{ code?: string | null; message?: string | null }> | null
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
  private base = 'https://partner.qatl.ru/api/reservation'
  private readonly logger = new Logger(ReservationService.name)

  constructor(
    private readonly oauth: OAuthService,
    private readonly authService: AuthService,
    private readonly users: UserService,
    private readonly mail: MailService,
  ) {}

  /**
   * Берём stayDates из TLRoomStay, если они есть (содержат корректные времена).
   * Если в ответе их нет, шлём только даты без времени.
   */
  buildStayDatesFromRoomStay(
    roomStay: TLRoomStay,
    arrival: string,
    departure: string,
  ): BookingStayDates {
    const arrivalDateTime =
      (roomStay as any)?.stayDates?.arrivalDateTime ?? arrival
    const departureDateTime =
      (roomStay as any)?.stayDates?.departureDateTime ?? departure

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
      body: (rs as any)?.body ?? undefined,
    }
  }

  private isCompleteRoomStay(rs: any): rs is TLRoomStay {
    return Boolean(
      rs?.roomType?.id && (rs?.ratePlan?.id || rs?.ratePlanId) && rs?.checksum,
    )
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
      return roomStay
    }

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

    const match = roomStays.find((rs) => {
      if (desiredChecksum && rs.checksum === desiredChecksum) return true
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

    if (!match) {
      throw new BadRequestException(
        'Выбранный номер недоступен на указанные даты. Попробуйте обновить результаты поиска.',
      )
    }

    return match
  }

  private async fetchRoomStays(
    propertyId: string,
    arrival: string,
    departure: string,
    guestsCount: BookingGuestCount,
    currency: string,
  ): Promise<TLRoomStay[]> {
    const baseUrl = `https://partner.qatl.ru/api/search/v1/properties/${propertyId}/room-stays`
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
      const resp = await this.oauth.get<{ roomStays: TLRoomStay[] }>(url)
      if (resp?.roomStays?.length) {
        return resp.roomStays
      }
    } catch (error) {
      // fallback to POST below
    }

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
    try {
      const res = await this.oauth.post<CreateBookingResult>(url, payload)

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

  private extractEmail(payload: CreateBookingRequest) {
    return (
      payload?.booking?.customer?.contacts?.emails
        ?.find((email) => email?.emailAddress?.trim())
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

  private calcGuestsCount(roomStay?: BookingRoomStayRq) {
    if (!roomStay?.guestCount) return null
    const adults = roomStay.guestCount.adultCount ?? 0
    const children = roomStay.guestCount.childAges?.length ?? 0
    const total = adults + children
    return total > 0 ? total : null
  }

  private getTotalAmount(result?: CreateBookingResult) {
    const total = result?.booking?.total
    if (!total) return null
    const price = total.priceBeforeTax ?? 0
    const tax = total.taxAmount ?? 0
    const sum = price + tax
    return Number.isFinite(sum) ? sum : null
  }

  private async processBookingSideEffects(
    payload: CreateBookingRequest,
    result?: CreateBookingResult | null,
  ) {
    const booking = result?.booking
    if (!booking?.number) {
      return
    }

    const email = this.extractEmail(payload)
    if (!email) {
      this.logger.warn(
        `Booking ${booking.number} created without customer email. Skipping user creation.`,
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

    await this.mail.sendMail({
      to: email,
      subject: `Подтверждение бронирования ${booking.number}`,
      text: lines.join('\n'),
    })
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
      return await this.oauth.post<GetBookingRs>(url, body)
    } catch (error) {
      this.handleAxiosError(error, 'cancelBooking')
    }
  }

  /**
   * Посчитать штраф за отмену
   */
  async calculatePenalty(number: string, cancellationDateTimeUtc: string) {
    const qs = new URLSearchParams({ cancellationDateTimeUtc }).toString()
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
   * 2) create -> получаем номер/статус (+ возможную оплату у отеля/без оплаты)
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
  }) {
    const {
      propertyId,
      roomStay,
      arrival,
      departure,
      guestsCount,
      customer,
      guests = [],
      paymentType,
      prepayRemark,
      prepaySum,
      perBookingServices,
    } = params

    // 2) один RoomStayRq из выбора
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

    this.logger.debug(
      `roomStay request for verify: ${JSON.stringify(roomStaysRq[0], null, 2)}`,
    )

    // this.logger.debug(
    //   `roomStay request: ${JSON.stringify(roomStaysRq[0], null, 2)}`,
    // )

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

    // 4) prepayment (если тебе надо указать тип, согласно твоей логике)
    const prepayment: BookingPrepayment | undefined = paymentType
      ? {
          paymentType,
          remark: prepayRemark ?? undefined,
          prepaidSum: prepaySum ?? undefined,
        }
      : undefined

    // 5) VERIFY (получить createBookingToken)
    const verifyPayload: VerifyBookingRequest = {
      booking: {
        propertyId,
        roomStays: roomStaysRq,
        customer: bookingCustomer,
        prepayment,
        services: perBookingServices ?? null,
      },
    }

    const verifyRes = await this.verifyBooking(verifyPayload)

    if (
      !verifyRes?.booking?.createBookingToken &&
      !verifyRes?.alternativeBooking?.createBookingToken
    ) {
      // нет токена для создания — вероятно предупреждение/невозможность
      return { verify: verifyRes, created: null }
    }

    const token =
      verifyRes.booking?.createBookingToken ??
      verifyRes.alternativeBooking?.createBookingToken!

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

    return { verify: verifyRes, created }
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
}
