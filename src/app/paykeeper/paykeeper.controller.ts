import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Res,
} from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { FastifyReply } from 'fastify'
import { PayKeeperService } from './paykeeper.service'
import type { PayKeeperCartItem } from './paykeeper.service'

@ApiTags('PayKeeper')
@Controller('paykeeper')
export class PayKeeperController {
  constructor(private readonly paykeeper: PayKeeperService) {}

  /**
   * Webhook: POST-оповещение от PayKeeper об успешном платеже.
   * Ответ строго в формате: "OK {MD5(id+SECRET_SEED)}" (text/plain).
   * URL этого эндпоинта нужно указать в личном кабинете PayKeeper.
   */
  @Post('notification')
  @ApiOperation({ summary: 'PayKeeper payment success webhook' })
  @ApiResponse({ status: 200, description: 'OK + hash' })
  @ApiResponse({ status: 400, description: 'Invalid payload' })
  async notification(
    @Body()
    body: {
      id?: string
      sum?: string
      clientid?: string
      orderid?: string
      key?: string
    },
    @Res() res: FastifyReply,
  ): Promise<void> {
    const id = body?.id ?? ''
    const sum = body?.sum ?? ''
    const key = body?.key ?? ''
    const clientid = body?.clientid ?? ''
    const orderid = body?.orderid ?? ''

    const result = this.paykeeper.handlePaymentNotification({
      id,
      sum,
      clientid,
      orderid,
      key,
    })

    if (!result.ok) {
      if (result.status === 400) {
        res.status(400).type('text/plain').send('')
        return
      }
      res.status(200).type('text/plain').send('Error! Hash mismatch')
      return
    }

    res.status(200).type('text/plain').send(result.response)
    if (orderid) {
      this.paykeeper.onPaymentSuccess(orderid, id, sum).catch(() => {})
    }
  }

  /**
   * Создание счёта и ссылки на оплату (для фронта или внутреннего вызова).
   * Корзина передаётся в формате PayKeeper (54-ФЗ при необходимости).
   */
  @Post('invoice')
  @ApiOperation({ summary: 'Create PayKeeper invoice and get payment link' })
  @ApiResponse({ status: 200, description: 'Payment link and invoice id' })
  async createInvoice(
    @Body()
    body: {
      orderId?: string | number
      amount?: number
      clientEmail?: string
      clientPhone?: string
      cart?: PayKeeperCartItem[]
    },
  ): Promise<{ paymentLink: string; invoiceId: string } | { error: string }> {
    if (!this.paykeeper.isEnabled()) {
      return { error: 'PayKeeper integration is disabled' }
    }
    const { orderId, amount, cart } = body ?? {}
    if (orderId === undefined || orderId === null || orderId === '') {
      throw new BadRequestException('orderId is required')
    }
    const numAmount = typeof amount === 'number' ? amount : Number(amount)
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      throw new BadRequestException('amount must be a positive number')
    }
    if (!Array.isArray(cart) || cart.length === 0) {
      throw new BadRequestException('cart must be a non-empty array of items')
    }

    const result = await this.paykeeper.createInvoice({
      orderId,
      amount: numAmount,
      clientEmail: body.clientEmail ?? '',
      clientPhone: body.clientPhone ?? '',
      cart,
    })

    if (!result) {
      return { error: 'Failed to create PayKeeper invoice' }
    }
    return result
  }
}
