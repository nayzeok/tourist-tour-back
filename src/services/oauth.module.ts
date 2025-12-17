import { Module } from '@nestjs/common'
import { OAuthService } from './oauth.service'
import { RedisModule } from '~/redis/redis.module'

@Module({
  imports: [RedisModule],
  providers: [OAuthService],
  exports: [OAuthService],
})
export class OAuthModule {}
