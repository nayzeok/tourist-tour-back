import {
  Body,
  Controller,
  Get,
  Inject,
  Patch,
  Query,
  Req,
  UseGuards,
  ForbiddenException,
  forwardRef,
} from '@nestjs/common'
import { FastifyRequest } from 'fastify'
import { JwtAuthGuard } from '~/guards/jwt-auth.guard'
import { UserService, PublicUser } from './user.service'
import { GetBookingsQueryDto } from './dto/get-bookings.dto'
import { ChangePasswordDto } from './dto/change-password.dto'
import { AuthService } from '~/app/auth/auth.service'

interface AuthenticatedRequest extends FastifyRequest {
  user?: PublicUser
}

@Controller('users')
export class UserController {
  constructor(
      private readonly users: UserService,
      @Inject(forwardRef(() => AuthService))
      private readonly auth: AuthService,
  ) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: AuthenticatedRequest) {
    const user = req.user?.id ? await this.users.findById(req.user.id) : null
    if (!user && req.user) {
      return { user: req.user }
    }
    if (!user) {
      return { user: null }
    }
    return { user: this.users.toPublicUser(user) }
  }

  @Get('bookings')
  @UseGuards(JwtAuthGuard)
  async bookings(
      @Req() req: AuthenticatedRequest,
      @Query() query: GetBookingsQueryDto,
  ) {
    if (!req.user) {
      return { total: 0, page: 1, pageSize: 0, items: [] }
    }
    const { page, pageSize } = query
    return this.users.getBookings(req.user.id, page, pageSize)
  }

  /**
   * Получить все бронирования (только для SUPERADMIN)
   */
  @Get('admin/bookings')
  @UseGuards(JwtAuthGuard)
  async allBookings(
      @Req() req: AuthenticatedRequest,
      @Query() query: GetBookingsQueryDto,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Не авторизован')
    }

    // Проверяем роль пользователя
    const user = await this.users.findById(req.user.id)
    if (!user || user.role !== 'SUPERADMIN') {
      throw new ForbiddenException('Доступ запрещён. Требуется роль SUPERADMIN.')
    }

    const { page, pageSize } = query
    return this.users.getAllBookings(page, pageSize)
  }

  @Patch('password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
      @Req() req: AuthenticatedRequest,
      @Body() body: ChangePasswordDto,
  ) {
    if (!req.user) {
      return { success: false }
    }
    await this.auth.changePassword(
        req.user.id,
        body.currentPassword,
        body.newPassword,
    )
    return { success: true }
  }
}