import {
  Controller, Get, Post, Patch, Param, Body, Query,
  UseGuards, Req, BadRequestException, ForbiddenException,
} from '@nestjs/common'
import { RentUserService } from './rent-user.service'
import { JwtAuthGuard } from '~/guards/jwt-auth.guard'
import { FastifyRequest } from 'fastify'

interface AuthRequest extends FastifyRequest {
  user?: { id: string; email: string; role: string; firstName?: string | null; lastName?: string | null; phone?: string | null }
}

@Controller('rent-user')
export class RentUserController {
  constructor(private readonly svc: RentUserService) {}

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

  // ─── POST /rent-user/profile ──────────────────────────────────────────────
  @Post('profile')
  @UseGuards(JwtAuthGuard)
  async saveProfile(@Req() req: AuthRequest, @Body() body: any) {
    return this.svc.saveProfile(req.user!.id, body)
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
