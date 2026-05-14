import {
  Injectable,
  Logger,
  OnModuleInit,
  Inject,
  forwardRef,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ConfigType } from '@nestjs/config'
import paykeeperConfig from '~/config/paykeeper.config'
import { createHash } from 'crypto'
import { DbService } from '~/db/db.service'
import { RentProgService } from '~/app/rentprog/rentprog.service'

export interface PayKeeperCartItem {
  name: string
  price: number
  quantity: number
  sum: number
  tax: string
  item_type: 'goods' | 'service'
}

export interface CreateInvoiceParams {
  orderId: string | number
  amount: number
  clientEmail?: string
  clientPhone?: string
  cart: PayKeeperCartItem[]
}

export interface CreateInvoiceResult {
  paymentLink: string
  invoiceId: string
}

export interface PaymentNotificationPayload {
  id: string
  sum: string
  clientid?: string
  orderid?: string
  key: string
}

@Injectable()
export class PayKeeperService implements OnModuleInit {
  private readonly logger = new Logger(PayKeeperService.name)
  private config: ConfigType<typeof paykeeperConfig> | null = null

  constructor(
    private readonly configService: ConfigService,
    private readonly db: DbService,
    @Inject(forwardRef(() => RentProgService)) private readonly rentprog: RentProgService,
  ) {}

  onModuleInit() {
    this.config = this.configService.get<ConfigType<typeof paykeeperConfig>>('paykeeper') ?? null
    if (!this.config?.enabled) {
      this.logger.log('PayKeeper integration disabled (PAYKEEPER_ENABLED != true)')
    }
  }

  /** Включена ли интеграция (создание счетов). Секрет (PAYKEEPER_SECRET_SEED) нужен только для webhook. */
  isEnabled(): boolean {
    return Boolean(
      this.config?.enabled &&
        this.config?.server &&
        this.config?.user != null &&
        this.config?.password != null
    )
  }

  private getBaseUrl(): string {
    const server = this.config?.server ?? ''
    return server.replace(/\/$/, '')
  }

  private getAuthHeader(): string {
    const user = this.config?.user ?? ''
    const password = this.config?.password ?? ''
    const credentials = Buffer.from(`${user}:${password}`).toString('base64')
    return `Basic ${credentials}`
  }

  private async getToken(): Promise<string | null> {
    if (!this.isEnabled()) return null
    const baseUrl = this.getBaseUrl()
    const url = `${baseUrl}/info/settings/token/`
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: this.getAuthHeader(),
      },
    })
    if (!res.ok) {
      this.logger.warn(`PayKeeper getToken failed: ${res.status} ${res.statusText}`)
      return null
    }
    const data = (await res.json()) as { token?: string }
    return data.token ?? null
  }

  /**
   * Создание счёта с двухстадийной оплатой (холд депозита).
   * two_stage=1 — деньги блокируются на карте, но не списываются.
   */
  async createHoldInvoice(params: CreateInvoiceParams): Promise<CreateInvoiceResult | null> {
    if (!this.isEnabled()) return null
    const token = await this.getToken()
    if (!token) return null

    const { orderId, amount, clientEmail = '', clientPhone = '', cart } = params
    const serviceName = `;PKC|${JSON.stringify(cart)}|`
    const baseUrl = this.getBaseUrl()
    const body = new URLSearchParams({
      pay_amount: String(amount),
      orderid: String(orderId),
      service_name: serviceName,
      client_email: clientEmail,
      client_phone: clientPhone,
      two_stage: '1',
      token,
    })

    const res = await fetch(`${baseUrl}/change/invoice/preview/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: this.getAuthHeader(),
        'Content-Length': String(Buffer.byteLength(body.toString())),
      },
      body: body.toString(),
    })

    if (!res.ok) {
      this.logger.warn(`PayKeeper createHoldInvoice failed: ${res.status} ${res.statusText}`)
      return null
    }

    const data = (await res.json()) as { invoice_id?: string }
    const invoiceId = data.invoice_id
    if (!invoiceId) return null

    const paymentLink = `${baseUrl}/bill/${invoiceId}/`
    this.logger.log(`PayKeeper hold invoice created: orderid=${orderId} invoiceId=${invoiceId}`)
    return { paymentLink, invoiceId }
  }

  /** Подтверждение холда (capture): списывает amount, остаток разблокируется */
  async capturePayment(paymentId: string, amount: number): Promise<boolean> {
    if (!this.isEnabled()) return false
    const token = await this.getToken()
    if (!token) return false

    const baseUrl = this.getBaseUrl()
    const body = new URLSearchParams({
      id: paymentId,
      amount: String(amount),
      token,
    })

    const res = await fetch(`${baseUrl}/change/payment/confirm/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: this.getAuthHeader(),
      },
      body: body.toString(),
    })

    if (!res.ok) {
      this.logger.warn(`PayKeeper capturePayment failed: ${res.status} ${paymentId}`)
      return false
    }
    this.logger.log(`PayKeeper capturePayment ok: id=${paymentId} amount=${amount}`)
    return true
  }

  /** Отмена холда (void): полностью разблокирует деньги */
  async voidPayment(paymentId: string): Promise<boolean> {
    if (!this.isEnabled()) return false
    const token = await this.getToken()
    if (!token) return false

    const baseUrl = this.getBaseUrl()
    const body = new URLSearchParams({ id: paymentId, token })

    const res = await fetch(`${baseUrl}/change/payment/void/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: this.getAuthHeader(),
      },
      body: body.toString(),
    })

    if (!res.ok) {
      this.logger.warn(`PayKeeper voidPayment failed: ${res.status} ${paymentId}`)
      return false
    }
    this.logger.log(`PayKeeper voidPayment ok: id=${paymentId}`)
    return true
  }

  /**
   * Создание счёта и ссылки на оплату (по документации PayKeeper Node.js).
   * https://docs.paykeeper.ru/vozmozhnosti-i-primery-ispolzovaniya/primer-koda-dlya-yazyka-nodejs/
   */
  async createInvoice(params: CreateInvoiceParams): Promise<CreateInvoiceResult | null> {
    if (!this.isEnabled()) {
      this.logger.warn('PayKeeper disabled, createInvoice skipped')
      return null
    }

    const token = await this.getToken()
    if (!token) {
      this.logger.warn('PayKeeper getToken returned no token')
      return null
    }

    const { orderId, amount, clientEmail = '', clientPhone = '', cart } = params
    const serviceName = `;PKC|${JSON.stringify(cart)}|`
    const baseUrl = this.getBaseUrl()
    const body = new URLSearchParams({
      pay_amount: String(amount),
      orderid: String(orderId),
      service_name: serviceName,
      client_email: clientEmail,
      client_phone: clientPhone,
      token,
    })

    const url = `${baseUrl}/change/invoice/preview/`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: this.getAuthHeader(),
        'Content-Length': String(Buffer.byteLength(body.toString())),
      },
      body: body.toString(),
    })

    if (!res.ok) {
      this.logger.warn(`PayKeeper createInvoice failed: ${res.status} ${res.statusText}`)
      return null
    }

    const data = (await res.json()) as { invoice_id?: string }
    const invoiceId = data.invoice_id
    if (!invoiceId) {
      this.logger.warn('PayKeeper createInvoice: no invoice_id in response')
      return null
    }

    const paymentLink = `${baseUrl}/bill/${invoiceId}/`
    this.logger.log(`PayKeeper invoice created: orderid=${orderId} invoiceId=${invoiceId}`)
    return { paymentLink, invoiceId }
  }

  /**
   * Проверка подписи и формирование ответа на POST-оповещение об успешном платеже.
   * Ответ должен быть строго: "OK " + MD5(id + SECRET_SEED)
   */
  handlePaymentNotification(payload: PaymentNotificationPayload): { ok: true; response: string } | { ok: false; status: number } {
    const secretSeed = this.config?.secretSeed ?? ''
    if (!secretSeed) {
      this.logger.warn('PayKeeper secret seed not set')
      return { ok: false, status: 400 }
    }

    const { id, sum, clientid = '', orderid = '', key } = payload
    if (!id || !sum || !key) {
      this.logger.warn('PayKeeper notification: missing id, sum or key')
      return { ok: false, status: 400 }
    }

    const sumFixed = Number(sum).toFixed(2)
    const expectedKey = createHash('md5')
      .update(`${id}${sumFixed}${clientid}${orderid}${secretSeed}`)
      .digest('hex')

    if (key !== expectedKey) {
      this.logger.warn('PayKeeper notification: hash mismatch')
      return { ok: false, status: 200 }
    }

    const responseHash = createHash('md5')
      .update(`${id}${secretSeed}`)
      .digest('hex')
    const response = `OK ${responseHash}`

    this.logger.log(`PayKeeper payment success: id=${id} orderid=${orderid} sum=${sum}`)
    return { ok: true, response }
  }

  /**
   * Вызывается после успешной проверки webhook: можно обновить бронь (оплачено).
   * В текущей схеме Booking нет поля paymentStatus — при необходимости его добавляют в Prisma.
   */
  async onPaymentSuccess(orderId: string, _paymentId: string, _sum: string): Promise<void> {
    const booking = await this.db.booking.findUnique({
      where: { number: orderId },
    })
    if (booking) {
      this.logger.log(`Booking ${orderId} linked to successful PayKeeper payment`)
    }
  }

  /**
   * Вызывается после авторизации холда (orderId = 'rent_hold_' + bookingId).
   * Деньги заблокированы, но не списаны. Активируем бронь, сохраняем paymentId.
   */
  async onRentHoldSuccess(bookingId: string, paymentId: string, sum: string): Promise<void> {
    const booking = await this.db.rentBooking.findUnique({ where: { id: bookingId } })
    if (!booking) {
      this.logger.error(`RentBooking ${bookingId} not found (hold)`)
      return
    }

    await this.db.rentBooking.update({
      where: { id: bookingId },
      data: {
        paymentStatus: 'paid',
        paidAmount: booking.totalAmount ?? Number(sum),
        status: 'active',
        depositStatus: 'held',
        paykeeperPaymentId: paymentId,
      },
    })
    this.logger.log(`RentBooking ${bookingId} deposit held, paymentId=${paymentId}`)

    // Активируем бронь в RentProg
    if (booking.rentprogId) {
      const rpId = Number(booking.rentprogId)
      await this.rentprog.updateBooking(rpId, { active: true })
        .catch((e: any) => this.logger.warn(`Failed to activate RentProg booking ${rpId}: ${e?.message}`))

      if (booking.totalAmount && booking.totalAmount > 0) {
        await this.rentprog.createPayment(rpId, [{ sum: booking.totalAmount, group: 1 }])
          .catch((e: any) => this.logger.warn(`Failed to create RentProg payment: ${e?.message}`))
      }
    }
  }

  /** Вызывается после успешного webhook для аренды авто (orderId = 'rent_' + bookingId) */
  async onRentPaymentSuccess(bookingId: string, sum: string): Promise<void> {
    const amount = Number(sum)

    // 1. Загружаем локальную бронь
    const booking = await this.db.rentBooking.findUnique({
      where: { id: bookingId },
      include: { user: true },
    })
    if (!booking) {
      this.logger.error(`RentBooking ${bookingId} not found`)
      return
    }

    // 2. Если бронь ещё не создана в RentProg — создаём
    if (!booking.rentprogId) {
      try {
        // Находим/создаём клиента
        const client = await this.rentprog.createClient({
          name: booking.firstName,
          lastname: booking.lastName,
          phone: booking.phone,
          email: booking.user?.email || '',
        })
        const clientId = client?.id || client?.client?.id

        const days = Math.max(1, Math.ceil(
          (booking.endDate.getTime() - booking.startDate.getTime()) / 86400000
        ))

        const formatDate = (d: Date) => {
          const day = String(d.getDate()).padStart(2, '0')
          const month = String(d.getMonth() + 1).padStart(2, '0')
          const year = d.getFullYear()
          const hours = String(d.getHours()).padStart(2, '0')
          const minutes = String(d.getMinutes()).padStart(2, '0')
          return `${day}-${month}-${year} ${hours}:${minutes}`
        }

        const rpBooking = await this.rentprog.createBooking({
          car_id: Number(booking.carId),
          start_date: formatDate(booking.startDate),
          end_date: formatDate(booking.endDate),
          days,
          start_place: booking.pickupLocation || 'Офис аренды',
          end_place: booking.returnLocation || booking.pickupLocation || 'Офис аренды',
          client_id: clientId || undefined,
          name: booking.firstName,
          lastname: booking.lastName,
          phone: booking.phone,
          email: booking.user?.email || '',
          active: true,
          manual_editing: false,
          rental_cost: booking.totalAmount || amount,
          total: booking.totalAmount || amount,
        })

        const rentprogId = String(rpBooking?.id || rpBooking?.booking?.id || '')
        this.logger.log(`RentProg booking created after payment: id=${rentprogId}`)

        // 3. Обновляем локальную бронь
        await this.db.rentBooking.update({
          where: { id: bookingId },
          data: {
            rentprogId,
            paymentStatus: 'paid',
            paidAmount: Number.isFinite(amount) ? amount : undefined,
            status: 'active',
          },
        })

        // 4. Фиксируем оплату в RentProg
        if (rentprogId && Number.isFinite(amount) && amount > 0) {
          await this.rentprog.createPayment(Number(rentprogId), [{ sum: amount, group: 1 }])
            .catch((e: any) => this.logger.error(`Failed to create RentProg payment: ${e?.message}`))
        }
      } catch (e: any) {
        this.logger.error(`Failed to create RentProg booking after payment: ${e?.message}`)
      }
      return
    }

    // Бронь уже была в RentProg — просто активируем и фиксируем оплату
    const rpId = Number(booking.rentprogId)
    await this.db.rentBooking.update({
      where: { id: bookingId },
      data: {
        paymentStatus: 'paid',
        paidAmount: Number.isFinite(amount) ? amount : undefined,
        status: 'active',
      },
    })
    this.logger.log(`RentBooking ${bookingId} marked as paid, amount=${sum}`)

    try {
      await this.rentprog.updateBooking(rpId, { active: true })
      this.logger.log(`RentProg booking ${rpId} activated`)
    } catch (e: any) {
      this.logger.error(`Failed to activate RentProg booking ${rpId}: ${e?.message}`)
    }

    if (Number.isFinite(amount) && amount > 0) {
      await this.rentprog.createPayment(rpId, [{ sum: amount, group: 1 }])
        .catch((e: any) => this.logger.error(`Failed to create RentProg payment for ${rpId}: ${e?.message}`))
    }
  }
}
