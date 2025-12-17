import { Module } from '@nestjs/common'
import { SearchService } from '~/app/search/search.service'
import { SearchController } from '~/app/search/search.controller'
import { OAuthModule } from '~/services/oauth.module'
import { DbModule } from '~/db/db.module'
import { RedisModule } from '~/redis/redis.module'

@Module({
  imports: [OAuthModule, DbModule, RedisModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
