import { Module } from '@nestjs/common'
import { RentUserService } from './rent-user.service'
import { RentUserController } from './rent-user.controller'
import { DbModule } from '~/db/db.module'
import { AuthModule } from '~/app/auth/auth.module'

@Module({
  imports: [DbModule, AuthModule],
  controllers: [RentUserController],
  providers: [RentUserService],
  exports: [RentUserService],
})
export class RentUserModule {}
