import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common'
import { DbService } from '~/db/db.service'

@Injectable()
export class RentUserService {
  constructor(private readonly prisma: DbService) {}

  // ─── Бронирования пользователя ────────────────────────────────────────────

  async getUserBookings(userId: string, status?: string) {
    const where: any = { userId }
    if (status) where.status = status

    return this.prisma.rentBooking.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })
  }

  async getBookingById(id: string, userId: string) {
    const booking = await this.prisma.rentBooking.findUnique({ where: { id } })
    if (!booking) throw new NotFoundException('Бронирование не найдено')
    if (booking.userId !== userId) throw new ForbiddenException('Нет доступа')
    return booking
  }

  async createBooking(userId: string, data: {
    rentprogId?: string
    carId: string
    carName: string
    carImage?: string
    city?: string
    startDate: string
    endDate: string
    pickupLocation?: string
    returnLocation?: string
    firstName: string
    lastName: string
    phone: string
    totalAmount?: number
    depositAmount?: number
  }) {
    return this.prisma.rentBooking.create({
      data: {
        userId,
        rentprogId: data.rentprogId,
        carId: data.carId,
        carName: data.carName,
        carImage: data.carImage,
        city: data.city,
        startDate: new Date(data.startDate),
        endDate: new Date(data.endDate),
        pickupLocation: data.pickupLocation,
        returnLocation: data.returnLocation,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        totalAmount: data.totalAmount,
        depositAmount: data.depositAmount,
        status: 'new',
        paymentStatus: 'unpaid',
      },
    })
  }

  async updateBookingRentprogId(id: string, rentprogId: string) {
    return this.prisma.rentBooking.update({
      where: { id },
      data: { rentprogId },
    })
  }

  async getBookingForAdmin(id: string) {
    return this.prisma.rentBooking.findUnique({ where: { id } })
  }

  async adminUpdateBookingDeposit(id: string, data: { status?: string; depositStatus?: string }) {
    return this.prisma.rentBooking.update({
      where: { id },
      data,
    })
  }

  async cancelBooking(id: string, userId: string) {
    const booking = await this.getBookingById(id, userId)
    if (['cancelled', 'completed'].includes(booking.status)) {
      throw new ForbiddenException('Невозможно отменить бронирование в текущем статусе')
    }
    return this.prisma.rentBooking.update({
      where: { id },
      data: { status: 'cancelled' },
    })
  }

  // ─── Все бронирования (для админа) ───────────────────────────────────────

  async getAllBookings(filters: {
    status?: string
    paymentStatus?: string
    userId?: string
    page?: number
    perPage?: number
  }) {
    const { status, paymentStatus, userId, page = 1, perPage = 20 } = filters
    const where: any = {}
    if (status) where.status = status
    if (paymentStatus) where.paymentStatus = paymentStatus
    if (userId) where.userId = userId

    const [items, total] = await Promise.all([
      this.prisma.rentBooking.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true, phone: true } } },
      }),
      this.prisma.rentBooking.count({ where }),
    ])

    return { items, total, page, perPage }
  }

  async adminUpdateBooking(id: string, data: {
    status?: string
    paymentStatus?: string
    paidAmount?: number
    startDate?: string
    endDate?: string
    pickupLocation?: string
    returnLocation?: string
  }) {
    const update: any = {}
    if (data.status) update.status = data.status
    if (data.paymentStatus) update.paymentStatus = data.paymentStatus
    if (data.paidAmount !== undefined) update.paidAmount = data.paidAmount
    if (data.startDate) update.startDate = new Date(data.startDate)
    if (data.endDate) update.endDate = new Date(data.endDate)
    if (data.pickupLocation !== undefined) update.pickupLocation = data.pickupLocation
    if (data.returnLocation !== undefined) update.returnLocation = data.returnLocation

    return this.prisma.rentBooking.update({ where: { id }, data: update })
  }

  // ─── Профиль пользователя (Мои данные) ───────────────────────────────────

  async getProfile(userId: string) {
    return this.prisma.userProfile.findUnique({ where: { userId } })
  }

  async saveProfile(userId: string, data: {
    passportSeries?: string
    passportNumber?: string
    passportIssuedBy?: string
    passportIssuedDate?: string
    passportCode?: string
    registrationAddress?: string
    licenseNumber?: string
    licenseIssuedDate?: string
    licenseExpiryDate?: string
  }) {
    const existing = await this.prisma.userProfile.findUnique({ where: { userId } })

    if (existing?.isLocked) {
      throw new ForbiddenException('Данные заблокированы для редактирования. Обратитесь к администратору.')
    }

    return this.prisma.userProfile.upsert({
      where: { userId },
      create: { userId, ...data, isLocked: true },
      update: data,
    })
  }

  async adminUnlockProfile(userId: string) {
    return this.prisma.userProfile.update({
      where: { userId },
      data: { isLocked: false },
    })
  }

  async adminUpdateProfile(userId: string, data: Record<string, string | boolean>) {
    return this.prisma.userProfile.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    })
  }
}
