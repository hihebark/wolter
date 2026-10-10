import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WolterModule } from '@wolter/core';
import { TypeORMPlugin } from '@wolter/typeorm';
import { NodePlugin } from '@wolter/node';
import { AppController } from './app.controller';
import { User } from './user.entity';

const typeormPlugin = new TypeORMPlugin({ captureParameters: true });

@Module({
  imports: [
    WolterModule.forRoot({
      storage: { driver: 'sqlite', path: './wolter.db' },
      // Local demo only: no guard, so the dashboard (and every captured
      // header/body/SQL parameter) is readable by anyone who can reach the
      // port. A real deployment sets dashboard.guard instead.
      dashboard: { path: '/wolter', allowUnauthenticated: true },
      capture: { headers: true, body: true, ignoreHeaders: ['x-request-id'], ignoreBodyFields: ['password'] },
      plugins: [typeormPlugin, new NodePlugin({ interval: 3_000 })],
    }),
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: './app.db',
      entities: [User],
      synchronize: true,
      logger: typeormPlugin,
    }),
    TypeOrmModule.forFeature([User]),
  ],
  controllers: [AppController],
})
export class AppModule {}
