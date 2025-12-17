import { forwardRef, Module } from '@nestjs/common'
import { UserController } from './user.controller'
import { UserService } from './user.service'
import { DbModule } from '~/db/db.module'
import { AuthModule } from '~/app/auth/auth.module'

@Module({
  imports: [DbModule, forwardRef(() => AuthModule)],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
