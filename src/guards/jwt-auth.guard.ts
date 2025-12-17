import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { FastifyRequest } from 'fastify'
import { ConfigType } from '@nestjs/config'
import authConfig from '~/config/auth.config'
import { UserService } from '~/app/user/user.service'

export interface JwtPayload {
  sub: string
  email: string
  role: string
  iat?: number
  exp?: number
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly users: UserService,
    @Inject(authConfig.KEY)
    private readonly auth: ConfigType<typeof authConfig>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: any }>()

    const token = request.cookies?.[this.auth.cookieName]

    if (!token) {
      throw new UnauthorizedException('Authentication cookie missing')
    }

    let payload: JwtPayload

    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: this.auth.jwtSecret,
      })
    } catch {
      throw new UnauthorizedException('Invalid or expired token')
    }

    const user = await this.users.findById(payload.sub)

    if (!user) {
      throw new UnauthorizedException('User not found')
    }

    request.user = this.users.toPublicUser(user)

    return true
  }
}
