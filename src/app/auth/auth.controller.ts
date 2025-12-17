import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
import { AuthService } from './auth.service'
import { RequestPasswordDto } from './dto/request-password.dto'
import { LoginDto } from './dto/login.dto'
import { RegisterDto } from './dto/register.dto'
import { JwtAuthGuard } from '~/guards/jwt-auth.guard'
import type { PublicUser } from '~/app/user/user.service'

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('request-password')
  async requestPassword(@Body() body: RequestPasswordDto) {
    await this.auth.issueNewPassword(body.email)

    return { message: 'Password has been sent' }
  }

  @Post('login')
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const user = await this.auth.validateUser(body.email, body.password)

    await this.auth.attachAuthCookie(reply, user)

    return { user: this.auth.toPublicUser(user) }
  }

  @Post('register')
  async register(
    @Body() body: RegisterDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.registerUser({
      email: body.email,
      firstName: body.firstName ?? null,
      lastName: body.lastName ?? null,
      phone: body.phone ?? null,
      password: body.password,
    })

    await this.auth.attachAuthCookie(reply, {
      id: result.entity.id,
      email: result.entity.email,
      role: result.entity.role,
    })

    return { user: result.user }
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) reply: FastifyReply) {
    this.auth.clearAuthCookie(reply)
    return { success: true }
  }

  @Get('status')
  @UseGuards(JwtAuthGuard)
  status(@Req() request: FastifyRequest & { user?: PublicUser }) {
    return { authorized: true, user: request.user }
  }
}
