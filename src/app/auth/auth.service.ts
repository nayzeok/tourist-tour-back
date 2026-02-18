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

  private getSiteUrl() {
    const raw =
      this.configService.get<string>('SITE_URL') ||
      this.configService.get<string>('FRONTEND_URL') ||
      'https://tourist-tours.ru'
    return raw.replace(/\/+$/, '')
  }

  private getDisplayName(details: {
    email: string
    firstName?: string | null
    lastName?: string | null
  }) {
    const fullName = [details.firstName, details.lastName]
      .filter(Boolean)
      .join(' ')
      .trim()
    if (fullName) return fullName
    return details.email
  }

  private buildWelcomeTemplateVariables(details: {
    email: string
    firstName?: string | null
    lastName?: string | null
    tempPassword?: string
  }) {
    const siteUrl = this.getSiteUrl()
    return {
      name: this.getDisplayName(details),
      email: details.email,
      temp_password: details.tempPassword ?? '',
      login_url: `${siteUrl}/acc`,
      support_email:
        this.configService.get<string>('SUPPORT_EMAIL') ??
        'support@tourist-tours.ru',
      current_year: new Date().getFullYear(),
      unsubscribe_url:
        this.configService.get<string>('RUSENDER_UNSUBSCRIBE_URL') ??
        `${siteUrl}/unsubscribe`,
    }
  }

  private buildPasswordResetTemplateVariables(details: {
    email: string
    firstName?: string | null
    lastName?: string | null
  }) {
    const siteUrl = this.getSiteUrl()
    return {
      name: this.getDisplayName({
        email: details.email,
        firstName: details.firstName,
        lastName: details.lastName,
      }),
      email: details.email,
      reset_ttl:
        this.configService.get<string>('RESET_PASSWORD_TTL') ??
        '15 минут',
      // Текущий flow создает временный пароль сразу, отдельного reset-token URL пока нет.
      reset_url: `${siteUrl}/acc`,
      support_email:
        this.configService.get<string>('SUPPORT_EMAIL') ??
        'support@tourist-tours.ru',
      current_year: new Date().getFullYear(),
      unsubscribe_url:
        this.configService.get<string>('RUSENDER_UNSUBSCRIBE_URL') ??
        `${siteUrl}/unsubscribe`,
    }
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
    const resetTemplateId = this.configService.get<string>(
      'RUSENDER_TEMPLATE_RESET',
    )

    await this.users.updatePassword(user.id, passwordHash)

    await this.mail.sendMail({
      to: normalizedEmail,
      subject: 'Ваш пароль для входа',
      text: `Ваш новый пароль: ${newPassword}`,
      ...(resetTemplateId
        ? {
            templateId: resetTemplateId,
            templateVariables: this.buildPasswordResetTemplateVariables({
              email: normalizedEmail,
              firstName: user.firstName,
              lastName: user.lastName,
            }),
          }
        : {}),
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
      const welcomeTemplateId = this.configService.get<string>(
        'RUSENDER_TEMPLATE_WELCOME',
      )
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
        ...(welcomeTemplateId
          ? {
              templateId: welcomeTemplateId,
              templateVariables: this.buildWelcomeTemplateVariables({
                email,
                firstName: details.firstName,
                lastName: details.lastName,
                tempPassword: password,
              }),
            }
          : {}),
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

    const welcomeTemplateId = this.configService.get<string>(
      'RUSENDER_TEMPLATE_WELCOME',
    )

    await this.mail.sendMail({
      to: email,
      subject: 'Регистрация в Tourist Tours',
      text: 'Ваш аккаунт успешно создан. Теперь вы можете входить и управлять бронированиями в личном кабинете.',
      ...(welcomeTemplateId
        ? {
            templateId: welcomeTemplateId,
            templateVariables: this.buildWelcomeTemplateVariables({
              email,
              firstName: details.firstName,
              lastName: details.lastName,
              tempPassword: details.password,
            }),
          }
        : {}),
    })

    return {
      entity: created,
      user: this.users.toPublicUser(created),
    }
  }
}
