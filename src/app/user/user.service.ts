import { Injectable } from '@nestjs/common'
import { Prisma, UserRole, User, Booking } from '@prisma/client'
import { DbService } from '~/db/db.service'

export interface CreateUserInput {
  email: string
  passwordHash: string
  firstName?: string | null
  lastName?: string | null
  phone?: string | null
  role?: UserRole
}

export interface PublicUser {
  id: string
  email: string
  role: UserRole
  firstName?: string | null
  lastName?: string | null
  phone?: string | null
}

export interface PaginatedBookings<T> {
  total: number
  page: number
  pageSize: number
  items: T[]
}

export interface UserBookingView {
  id: string
  number: string
  status: string
  propertyId?: string | null
  arrivalDate?: Date | null
  departureDate?: Date | null
  guestsCount?: number | null
  totalAmount?: number | null
  currency?: string | null
  payload?: unknown
  createdAt: Date
  updatedAt: Date
}

export interface SaveBookingInput {
  number: string
  status: string
  propertyId?: string | null
  arrivalDate?: Date | null
  departureDate?: Date | null
  guestsCount?: number | null
  totalAmount?: number | null
  currency?: string | null
  payload?: Prisma.JsonValue
}

@Injectable()
export class UserService {
  constructor(private readonly db: DbService) {}

  findByEmail(email: string): Promise<User | null> {
    const normalized = email.trim().toLowerCase()
    return this.db.user.findUnique({ where: { email: normalized } })
  }

  findById(id: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { id } })
  }

  create(input: CreateUserInput): Promise<User> {
    const normalizedEmail = input.email.trim().toLowerCase()
    return this.db.user.create({
      data: {
        email: normalizedEmail,
        passwordHash: input.passwordHash,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        phone: input.phone ?? null,
        role: input.role ?? UserRole.USER,
      },
    })
  }

  updatePassword(userId: string, passwordHash: string): Promise<User> {
    return this.db.user.update({
      where: { id: userId },
      data: { passwordHash },
    })
  }

  updateProfile(
    userId: string,
    data: {
      firstName?: string | null
      lastName?: string | null
      phone?: string | null
    },
  ): Promise<User | null> {
    const updateData: Prisma.UserUpdateInput = {}
    if (data.firstName !== undefined) updateData.firstName = data.firstName
    if (data.lastName !== undefined) updateData.lastName = data.lastName
    if (data.phone !== undefined) updateData.phone = data.phone

    if (Object.keys(updateData).length === 0) {
      return this.findById(userId)
    }

    return this.db.user.update({
      where: { id: userId },
      data: updateData,
    })
  }

  toPublicUser(user: {
    id: string
    email: string
    role: UserRole
    firstName?: string | null
    lastName?: string | null
    phone?: string | null
  }): PublicUser {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      phone: user.phone ?? null,
    }
  }

  async getBookings(
    userId: string,
    page: number,
    pageSize: number,
  ): Promise<PaginatedBookings<UserBookingView>> {
    const safePage = Math.max(page, 1)
    const safePageSize = Math.min(Math.max(pageSize, 1), 100)
    const skip = (safePage - 1) * safePageSize

    const [total, items] = await Promise.all([
      this.db.booking.count({ where: { userId } }),
      this.db.booking.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safePageSize,
      }),
    ])

    return {
      total,
      page: safePage,
      pageSize: safePageSize,
      items: items.map((booking) => ({
        id: booking.id,
        number: booking.number,
        status: booking.status,
        propertyId: booking.propertyId,
        arrivalDate: booking.arrivalDate,
        departureDate: booking.departureDate,
        guestsCount: booking.guestsCount,
        totalAmount: booking.totalAmount,
        currency: booking.currency,
        payload: booking.payload,
        createdAt: booking.createdAt,
        updatedAt: booking.updatedAt,
      })),
    }
  }

  saveBooking(userId: string, payload: SaveBookingInput): Promise<Booking> {
    return this.db.booking.upsert({
      where: { number: payload.number },
      update: {
        userId,
        status: payload.status,
        propertyId: payload.propertyId ?? null,
        arrivalDate: payload.arrivalDate ?? null,
        departureDate: payload.departureDate ?? null,
        guestsCount: payload.guestsCount ?? null,
        totalAmount: payload.totalAmount ?? null,
        currency: payload.currency ?? null,
        payload:
          payload.payload === undefined || payload.payload === null
            ? Prisma.JsonNull
            : payload.payload,
      },
      create: {
        userId,
        number: payload.number,
        status: payload.status,
        propertyId: payload.propertyId ?? null,
        arrivalDate: payload.arrivalDate ?? null,
        departureDate: payload.departureDate ?? null,
        guestsCount: payload.guestsCount ?? null,
        totalAmount: payload.totalAmount ?? null,
        currency: payload.currency ?? null,
        payload:
          payload.payload === undefined || payload.payload === null
            ? Prisma.JsonNull
            : payload.payload,
      },
    })
  }
}
