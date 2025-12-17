import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ConfigService, ConfigType } from '@nestjs/config'
import { randomBytes } from 'crypto'
import * as bcrypt from 'bcryptjs'
import { FastifyReply, FastifyRequest } from 'fastify'
import authConfig from '~/config/auth.config'
import { UserService } from '~/app/user/user.service'
import { MailService } from '~/services/mail.service'
import type { JwtPayload } from '~/guards/jwt-auth.guard'
import { UserRole } from '@prisma/client'

const SALT_ROUNDS = 10

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UserService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly configService: ConfigService,
    @Inject(authConfig.KEY)
    private readonly auth: ConfigType<typeof authConfig>,
  ) {}

  private get cookieOptions() {
    return {
      domain: this.auth.cookieDomain,
      path: '/',
      httpOnly: true,
      sameSite: this.auth.cookieSameSite,
      secure: this.auth.cookieSecure,
      maxAge: Math.floor(this.auth.cookieMaxAgeMs / 1000),
    }
  }

  private generatePassword(length = 12) {
    let password = ''
    while (password.length < length) {
      password += randomBytes(length)
        .toString('base64')
        .replace(/[^a-zA-Z0-9]/g, '')
    }
    return password.slice(0, length)
  }

  hashPassword(raw: string) {
    return bcrypt.hash(raw, SALT_ROUNDS)
  }

  comparePasswords(raw: string, hash: string) {
    return bcrypt.compare(raw, hash)
  }

  async issueNewPassword(email: string) {
    const normalizedEmail = email.trim().toLowerCase()
    const user = await this.users.findByEmail(normalizedEmail)

    if (!user) {
      throw new NotFoundException('User not found')
    }

    const newPassword = this.generatePassword()
    const passwordHash = await this.hashPassword(newPassword)

    await this.users.updatePassword(user.id, passwordHash)

    await this.mail.sendMail({
      to: normalizedEmail,
      subject: 'Ваш пароль для входа',
      text: `Ваш новый пароль: ${newPassword}`,
    })

    return { password: newPassword, user: this.users.toPublicUser(user) }
  }

  async validateUser(email: string, password: string) {
    const normalizedEmail = email.trim().toLowerCase()
    const user = await this.users.findByEmail(normalizedEmail)
    if (!user) {
      throw new UnauthorizedException('Invalid credentials')
    }

    const isValid = await this.comparePasswords(password, user.passwordHash)
    if (!isValid) {
      throw new UnauthorizedException('Invalid credentials')
    }

    return user
  }

  async signUser(user: { id: string; email: string; role: string }) {
    return this.jwt.signAsync(
      { sub: user.id, email: user.email, role: user.role },
      { expiresIn: this.auth.accessTokenTtl, secret: this.auth.jwtSecret },
    )
  }

  async attachAuthCookie(
    reply: FastifyReply,
    user: { id: string; email: string; role: string },
  ) {
    const token = await this.signUser(user)
    reply.setCookie(this.auth.cookieName, token, this.cookieOptions)
    return token
  }

  clearAuthCookie(reply: FastifyReply) {
    reply.clearCookie(this.auth.cookieName, { path: '/' })
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.users.findById(userId)
    if (!user) {
      throw new NotFoundException('User not found')
    }

    const matches = await this.comparePasswords(
      currentPassword,
      user.passwordHash,
    )
    if (!matches) {
      throw new BadRequestException('Current password is incorrect')
    }

    if (currentPassword === newPassword) {
      throw new BadRequestException(
        'New password must differ from the current password',
      )
    }

    const passwordHash = await this.hashPassword(newPassword)
    await this.users.updatePassword(userId, passwordHash)

    await this.mail.sendMail({
      to: user.email,
      subject: 'Пароль был изменен',
      text: 'Ваш пароль был успешно изменен.',
    })
  }

  async getUserFromRequest(request: FastifyRequest) {
    const token = request.cookies?.[this.auth.cookieName]
    if (!token) {
      return null
    }

    let payload: JwtPayload
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: this.auth.jwtSecret,
      })
    } catch {
      return null
    }

    const user = await this.users.findById(payload.sub)

    if (!user) {
      return null
    }

    return this.users.toPublicUser(user)
  }

  toPublicUser(user: {
    id: string
    email: string
    role: UserRole
    firstName?: string | null
    lastName?: string | null
    phone?: string | null
  }) {
    return this.users.toPublicUser(user)
  }

  async ensureUserForBooking(details: {
    email: string
    firstName?: string | null
    lastName?: string | null
    phone?: string | null
  }) {
    const email = details.email?.trim().toLowerCase()
    if (!email) {
      throw new BadRequestException(
        'Email is required for booking user creation',
      )
    }

    const existing = await this.users.findByEmail(email)
    if (!existing) {
      const password = this.generatePassword()
      const passwordHash = await this.hashPassword(password)
      const created = await this.users.create({
        email,
        passwordHash,
        firstName: details.firstName ?? null,
        lastName: details.lastName ?? null,
        phone: details.phone ?? null,
      })

      await this.mail.sendMail({
        to: email,
        subject: 'Ваш аккаунт создан',
        text: `Ваш пароль для входа: ${password}`,
      })

      return { user: created, isNew: true, password }
    }

    const updated = await this.users.updateProfile(existing.id, {
      firstName: details.firstName ?? undefined,
      lastName: details.lastName ?? undefined,
      phone: details.phone ?? undefined,
    })

    return { user: updated ?? existing, isNew: false, password: null }
  }

  async registerUser(details: {
    email: string
    firstName?: string | null
    lastName?: string | null
    phone?: string | null
    password: string
  }) {
    const email = details.email?.trim().toLowerCase()
    if (!email) {
      throw new BadRequestException('Email is required')
    }

    const existing = await this.users.findByEmail(email)
    if (existing) {
      throw new ConflictException('User already exists')
    }

    const passwordHash = await this.hashPassword(details.password)

    const created = await this.users.create({
      email,
      passwordHash,
      firstName: details.firstName ?? null,
      lastName: details.lastName ?? null,
      phone: details.phone ?? null,
    })

    return {
      entity: created,
      user: this.users.toPublicUser(created),
    }
  }
}
