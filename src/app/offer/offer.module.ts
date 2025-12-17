import { Module } from '@nestjs/common'
import { OAuthModule } from '~/services'
import { DbModule } from '~/db/db.module'
import { SearchService } from '~/app/search/search.service'
import { RedisModule } from '~/redis/redis.module'
import { OfferController } from '~/app/offer/offer.controller'
import { OfferService } from '~/app/offer/offer.service'

@Module({
  imports: [OAuthModule, DbModule, RedisModule],
  controllers: [OfferController],
  providers: [SearchService, OfferService],
})
export class OfferModule {}
