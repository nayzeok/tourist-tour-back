import { Module, forwardRef } from '@nestjs/common'
import { RentProgService } from './rentprog.service'
import { RentProgController } from './rentprog.controller'
import { RedisModule } from '~/redis/redis.module'
import { AuthModule } from '~/app/auth/auth.module'
import { UserModule } from '~/app/user/user.module'
import { ScheduleModule } from '@nestjs/schedule'
import { RentUserModule } from '~/app/rent-user/rent-user.module'
import { PayKeeperModule } from '~/app/paykeeper/paykeeper.module'

@Module({
  imports: [RedisModule, AuthModule, UserModule, ScheduleModule.forRoot(), forwardRef(() => RentUserModule), forwardRef(() => PayKeeperModule)],
  controllers: [RentProgController],
  providers: [RentProgService],
  exports: [RentProgService],
})
export class RentProgModule {}
