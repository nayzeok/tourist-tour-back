import { Module } from '@nestjs/common'
import { CitiesController } from './cities.controller'
import { CitiesService } from './cities.service'
import { DbModule } from '~/db/db.module'
import { RedisModule } from '~/redis/redis.module'
import { OAuthModule } from '~/services/oauth.module'

@Module({
  imports: [DbModule, RedisModule, OAuthModule],
  controllers: [CitiesController],
  providers: [CitiesService],
})
export class CitiesModule {}
