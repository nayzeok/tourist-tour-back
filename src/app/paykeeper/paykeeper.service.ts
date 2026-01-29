import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ConfigType } from '@nestjs/config'
import paykeeperConfig from '~/config/paykeeper.config'
import { createHash } from 'crypto'
import { DbService } from '~/db/db.service'

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
      // При добавлении paymentStatus в схему: await this.db.booking.update({ where: { number: orderId }, data: { paymentStatus: 'paid' } })
    }
  }
}
