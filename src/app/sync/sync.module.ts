import { Module } from '@nestjs/common'
import { SyncController } from './sync.controller'
import { SyncService } from './sync.service'
import { RedisModule } from '~/redis/redis.module'
import { OAuthModule } from '~/services/oauth.module'
import { ImageProxyModule } from '~/app/image-proxy/image-proxy.module'

@Module({
  imports: [RedisModule, OAuthModule, ImageProxyModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
