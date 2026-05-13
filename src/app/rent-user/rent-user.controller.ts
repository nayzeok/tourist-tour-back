import {
  Controller, Get, Post, Patch, Param, Body, Query,
  UseGuards, Req, BadRequestException, ForbiddenException, InternalServerErrorException,
  Inject, forwardRef,
} from '@nestjs/common'
import { RentUserService } from './rent-user.service'
import { JwtAuthGuard } from '~/guards/jwt-auth.guard'
import { MailService } from '~/services/mail.service'
import { PayKeeperService } from '~/app/paykeeper/paykeeper.service'
import { FastifyRequest } from 'fastify'

interface AuthRequest extends FastifyRequest {
  user?: { id: string; email: string; role: string; firstName?: string | null; lastName?: string | null; phone?: string | null }
}

@Controller('rent-user')
export class RentUserController {
  constructor(
    private readonly svc: RentUserService,
    private readonly mail: MailService,
    @Inject(forwardRef(() => PayKeeperService)) private readonly paykeeper: PayKeeperService,
  ) {}

  // ─── GET /rent-user/bookings ──────────────────────────────────────────────
  @Get('bookings')
  @UseGuards(JwtAuthGuard)
  async getMyBookings(
    @Req() req: AuthRequest,
    @Query('status') status?: string,
  ) {
    return this.svc.getUserBookings(req.user!.id, status)
  }

  // ─── GET /rent-user/bookings/:id ─────────────────────────────────────────
  @Get('bookings/:id')
  @UseGuards(JwtAuthGuard)
  async getBooking(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.svc.getBookingById(id, req.user!.id)
  }

  // ─── POST /rent-user/bookings/:id/cancel ─────────────────────────────────
  @Post('bookings/:id/cancel')
  @UseGuards(JwtAuthGuard)
  async cancelBooking(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.svc.cancelBooking(id, req.user!.id)
  }

  // ─── GET /rent-user/profile ───────────────────────────────────────────────
  @Get('profile')
  @UseGuards(JwtAuthGuard)
  async getProfile(@Req() req: AuthRequest) {
    return this.svc.getProfile(req.user!.id)
  }

  // ─── POST /rent-user/profile/change-request ──────────────────────────────
  @Post('profile/change-request')
  @UseGuards(JwtAuthGuard)
  async requestProfileChange(@Req() req: AuthRequest) {
    const user = req.user!
    const profile = await this.svc.getProfile(user.id)

    await this.mail.sendMail({
      to: 'nayzeok@gmail.com',
      subject: 'Запрос на изменение данных аренды',
      html: `
        <p>Пользователь запросил изменение заблокированных данных.</p>
        <ul>
          <li><b>Email:</b> ${user.email}</li>
          <li><b>Имя:</b> ${[user.firstName, user.lastName].filter(Boolean).join(' ') || '—'}</li>
          <li><b>Телефон:</b> ${user.phone || '—'}</li>
          <li><b>ID:</b> ${user.id}</li>
        </ul>
        <p>Текущие данные профиля:</p>
        <ul>
          <li>Серия/номер паспорта: ${profile?.passportSeries || '—'} ${profile?.passportNumber || ''}</li>
          <li>ВУ: ${profile?.licenseNumber || '—'}</li>
          <li>Адрес: ${profile?.registrationAddress || '—'}</li>
        </ul>
        <p>Для разблокировки профиля используйте панель администратора.</p>
      `,
    })

    return { ok: true }
  }

  // ─── POST /rent-user/profile ──────────────────────────────────────────────
  @Post('profile')
  @UseGuards(JwtAuthGuard)
  async saveProfile(@Req() req: AuthRequest, @Body() body: any) {
    return this.svc.saveProfile(req.user!.id, body)
  }

  // ─── POST /rent-user/bookings/:id/pay ────────────────────────────────────
  @Post('bookings/:id/pay')
  @UseGuards(JwtAuthGuard)
  async createPaymentLink(@Param('id') id: string, @Req() req: AuthRequest) {
    const user = req.user!
    const booking = await this.svc.getBookingById(id, user.id)

    if (booking.paymentStatus === 'paid') {
      throw new BadRequestException('Бронирование уже оплачено')
    }
    if (['cancelled', 'completed', 'archived'].includes(booking.status)) {
      throw new BadRequestException('Нельзя оплатить бронирование в текущем статусе')
    }

    const amount = booking.totalAmount
    if (!amount || amount <= 0) {
      throw new BadRequestException('Сумма бронирования не указана')
    }

    if (!this.paykeeper.isEnabled()) {
      throw new InternalServerErrorException('Оплата временно недоступна')
    }

    const result = await this.paykeeper.createInvoice({
      orderId: `rent_${booking.id}`,
      amount,
      clientEmail: user.email,
      clientPhone: booking.phone,
      cart: [{
        name: `Аренда автомобиля ${booking.carName}`,
        price: amount,
        quantity: 1,
        sum: amount,
        tax: 'none',
        item_type: 'service',
      }],
    })

    if (!result) {
      throw new InternalServerErrorException('Не удалось создать счёт на оплату')
    }

    return { paymentLink: result.paymentLink, invoiceId: result.invoiceId }
  }

  // ─── Админские эндпоинты ──────────────────────────────────────────────────

  // GET /rent-user/admin/bookings
  @Get('admin/bookings')
  @UseGuards(JwtAuthGuard)
  async adminGetBookings(
    @Req() req: AuthRequest,
    @Query('status') status?: string,
    @Query('paymentStatus') paymentStatus?: string,
    @Query('userId') userId?: string,
    @Query('page') page = '1',
    @Query('perPage') perPage = '20',
  ) {
    if (req.user?.role !== 'SUPERADMIN' && req.user?.role !== 'ADMIN') {
      throw new ForbiddenException('Нет доступа')
    }
    return this.svc.getAllBookings({
      status, paymentStatus, userId,
      page: Number(page), perPage: Number(perPage),
    })
  }

  // PATCH /rent-user/admin/bookings/:id
  @Patch('admin/bookings/:id')
  @UseGuards(JwtAuthGuard)
  async adminUpdateBooking(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: AuthRequest,
  ) {
    if (req.user?.role !== 'SUPERADMIN' && req.user?.role !== 'ADMIN') {
      throw new ForbiddenException('Нет доступа')
    }
    return this.svc.adminUpdateBooking(id, body)
  }

  // GET /rent-user/admin/profile/:userId
  @Get('admin/profile/:userId')
  @UseGuards(JwtAuthGuard)
  async adminGetProfile(@Param('userId') userId: string, @Req() req: AuthRequest) {
    if (req.user?.role !== 'SUPERADMIN' && req.user?.role !== 'ADMIN') {
      throw new ForbiddenException('Нет доступа')
    }
    return this.svc.getProfile(userId)
  }

  // POST /rent-user/admin/profile/:userId/unlock
  @Post('admin/profile/:userId/unlock')
  @UseGuards(JwtAuthGuard)
  async adminUnlockProfile(@Param('userId') userId: string, @Req() req: AuthRequest) {
    if (req.user?.role !== 'SUPERADMIN') throw new ForbiddenException('Нет доступа')
    return this.svc.adminUnlockProfile(userId)
  }

  // PATCH /rent-user/admin/profile/:userId
  @Patch('admin/profile/:userId')
  @UseGuards(JwtAuthGuard)
  async adminUpdateProfile(
    @Param('userId') userId: string,
    @Body() body: any,
    @Req() req: AuthRequest,
  ) {
    if (req.user?.role !== 'SUPERADMIN' && req.user?.role !== 'ADMIN') {
      throw new ForbiddenException('Нет доступа')
    }
    return this.svc.adminUpdateProfile(userId, body)
  }
}
