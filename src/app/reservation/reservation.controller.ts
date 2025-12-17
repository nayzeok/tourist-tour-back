// src/app/reservation/reservation.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { ReservationService } from './reservation.service'

// Подтягиваем типы из сервиса (или из общего shared, если так удобнее)
import type {
  VerifyBookingRequest,
  CreateBookingRequest,
  BookingCancellationRq,
  ResultOfCalculatePenalty,
  ModifyBookingRq,
} from './reservation.service'

@ApiTags('Reservation')
@Controller('reservation')
export class ReservationController {
  constructor(private readonly reservation: ReservationService) {}

  // ---------- Проверка возможности СОЗДАНИЯ брони ----------
  @Post('bookings/verify')
  @ApiOperation({ summary: 'Checking possibility of booking creation' })
  @ApiResponse({ status: 200, description: 'Verify result' })
  async verifyCreate(@Body() body: VerifyBookingRequest) {
    if (!body?.booking) {
      throw new BadRequestException('booking is required')
    }
    return this.reservation.verifyBooking(body)
  }

  // ---------- СОЗДАНИЕ брони ----------
  @Post('bookings')
  @ApiOperation({ summary: 'Create booking' })
  @ApiResponse({ status: 200, description: 'Created booking' })
  async create(@Body() body: CreateBookingRequest) {
    const token = body?.booking?.createBookingToken
    if (!token) {
      throw new BadRequestException(
        'createBookingToken is required (get it via /bookings/verify)',
      )
    }

    return this.reservation.createBooking(body)
  }

  // ---------- ПОЛУЧИТЬ бронь ----------
  @Get('bookings/:number')
  @ApiOperation({ summary: 'Receive booking by number' })
  @ApiResponse({ status: 200, description: 'Booking entity' })
  async get(@Param('number') number: string) {
    if (!number) throw new BadRequestException('number is required')
    return this.reservation.getBooking(number)
  }

  // ---------- ОТМЕНА брони ----------
  @Post('bookings/:number/cancel')
  @ApiOperation({ summary: 'Cancel booking' })
  @ApiResponse({ status: 200, description: 'Cancelled booking' })
  async cancel(
    @Param('number') number: string,
    @Body() body: BookingCancellationRq,
  ) {
    if (!number) throw new BadRequestException('number is required')
    return this.reservation.cancelBooking(number, body ?? {})
  }

  // ---------- Рассчитать штраф за отмену ----------
  @Get('bookings/:number/calculate-cancellation-penalty')
  @ApiOperation({ summary: 'Calculate penalty amount for cancellation' })
  @ApiResponse({ status: 200, description: 'Penalty amount result' })
  async penalty(
    @Param('number') number: string,
    @Query('cancellationDateTimeUtc') cancellationDateTimeUtc: string,
  ): Promise<ResultOfCalculatePenalty> {
    if (!number) throw new BadRequestException('number is required')
    if (!cancellationDateTimeUtc) {
      throw new BadRequestException(
        'cancellationDateTimeUtc is required (ISO: YYYY-MM-DDThh:mm:ssZ)',
      )
    }
    return this.reservation.calculatePenalty(number, cancellationDateTimeUtc)
  }

  // ---------- Проверка возможности МОДИФИКАЦИИ ----------
  @Post('bookings/:number/verify')
  @ApiOperation({ summary: 'Checking possibility of booking modification' })
  @ApiResponse({ status: 200, description: 'Verify modification result' })
  async verifyModify(
    @Param('number') number: string,
    @Body() body: { booking: ModifyBookingRq },
  ) {
    if (!number) throw new BadRequestException('number is required')
    if (!body?.booking) throw new BadRequestException('booking is required')
    return this.reservation.verifyModification(number, body)
  }

  // ---------- МОДИФИКАЦИЯ брони ----------
  @Post('bookings/:number/modify')
  @ApiOperation({ summary: 'Modify booking' })
  @ApiResponse({ status: 200, description: 'Modified booking' })
  async modify(
    @Param('number') number: string,
    @Body() body: { booking: ModifyBookingRq },
  ) {
    if (!number) throw new BadRequestException('number is required')
    if (!body?.booking) throw new BadRequestException('booking is required')
    if (!body.booking.version) {
      throw new BadRequestException(
        'booking.version is required (get it via GET /bookings/:number)',
      )
    }
    return this.reservation.modifyBooking(number, body)
  }

  // ---------- Упрощённый сценарий: QUICK BOOK ----------
  // Принимает roomStay (из Search), данные гостя и даты -> делает verify+create
  @Post('quick-book')
  @ApiOperation({
    summary:
      'Quick book (verify + create) from selected roomStay and guest form',
    description:
      'В теле передай: propertyId, roomStay (из Search), arrival, departure, guestsCount, customer {firstName,lastName,phone,email,citizenship?}, guests?[...], paymentType?, prepayRemark?, prepaySum?',
  })
  @ApiResponse({ status: 200, description: 'Verify + Create result' })
  async quickBook(
    @Body()
    body: {
      propertyId: string
      roomStay: any // TLRoomStay из Search
      arrival: string // YYYY-MM-DD
      departure: string // YYYY-MM-DD
      guestsCount: { adultCount: number; childAges?: number[] }
      customer: {
        firstName: string
        lastName: string
        phone: string
        email: string
        citizenship?: string
        comment?: string
      }
      guests?: Array<{
        firstName: string
        lastName: string
        middleName?: string
        citizenship?: string
      }>
      checkInTime?: string
      checkOutTime?: string
      paymentType?: 'Cash' | 'PrePay'
      prepayRemark?: string | null
      prepaySum?: number | null
      perBookingServices?: Array<{ id: string }>
    },
  ) {
    const required = [
      'propertyId',
      'roomStay',
      'arrival',
      'departure',
      'guestsCount',
      'customer',
    ] as const
    for (const k of required) {
      if (!(body as any)[k]) {
        throw new BadRequestException(`${k} is required`)
      }
    }

    return this.reservation.quickBook({
      propertyId: body.propertyId,
      roomStay: body.roomStay,
      arrival: body.arrival,
      departure: body.departure,
      guestsCount: body.guestsCount,
      customer: body.customer,
      guests: body.guests,
      checkInTime: body.checkInTime,
      checkOutTime: body.checkOutTime,
      paymentType: body.paymentType,
      prepayRemark: body.prepayRemark ?? null,
      prepaySum: body.prepaySum ?? null,
      perBookingServices: body.perBookingServices,
    })
  }
}
